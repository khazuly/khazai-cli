import { resolve } from "node:path";
import { shellTimeoutMs, testExecutionProfile } from "../lib/shell-command-policy.js";

function normalizedCommand(value) {
  const source = String(value || "").trim();
  let output = "";
  let quote = "";
  let escaped = false;
  let spacing = false;
  for (const character of source) {
    if (escaped) {
      output += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      output += character;
      escaped = true;
      continue;
    }
    if (quote) {
      output += character;
      if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"') {
      if (spacing && output) output += " ";
      spacing = false;
      quote = character;
      output += character;
      continue;
    }
    if (/\s/.test(character)) {
      spacing = true;
      continue;
    }
    if (spacing && output) output += " ";
    spacing = false;
    output += character;
  }
  return output;
}

function normalizedEnvironment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value)
    .map(([key, entry]) => [String(key), String(entry)])
    .sort(([left], [right]) => left.localeCompare(right));
}

function verificationCommand(command) {
  const source = normalizedCommand(command);
  return /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|build|typecheck)\b|(?:npx\s+)?(?:eslint|tsc|vitest|jest)\b|pytest\b|python(?:3)?\s+-m\s+(?:pytest|unittest)\b|go\s+test\b|cargo\s+test\b|git\s+(?:status|diff)\b)/i
    .test(source);
}

function requestedTimeout(args, workspace) {
  const cwd = resolve(workspace, String(args?.workdir || workspace));
  return shellTimeoutMs(args?.command, cwd, args?.timeout);
}

export class ShellScheduler {
  constructor(workspace) {
    this.workspace = workspace;
    this.revision = 0;
    this.records = new Map();
    this.activeScope = null;
  }

  beginRun(runId, turnId, taskEpoch, resume = false) {
    if (typeof taskEpoch === "boolean") {
      resume = taskEpoch;
      taskEpoch = null;
    }
    this.cancelActive();
    this.activeScope = { runId, turnId, taskEpoch };
    if (!resume) this.records.clear();
    else {
      for (const record of this.records.values()) {
        record.runId = runId;
        record.turnId = turnId;
        record.taskEpoch = taskEpoch;
      }
    }
  }

  cancelActive() {
    for (const record of this.records.values()) {
      if (!["pending", "running"].includes(record.status)) continue;
      record.status = "cancelled";
      record.completedAt = Date.now();
      record.error = "Cancelled";
    }
  }

  _signature(args) {
    const cwd = resolve(this.workspace, String(args?.workdir || this.workspace));
    return JSON.stringify({
      command: normalizedCommand(args?.command),
      cwd,
      environment: normalizedEnvironment(args?.env),
    });
  }

  reserve(call) {
    if (call?.name !== "bash") return null;
    const scope = this.activeScope;
    if (!scope) return null;
    const signature = this._signature(call.args);
    const stored = this.records.get(signature);
    const previous = stored?.revision === this.revision ? stored : null;
    if (previous?.status === "completed") {
      return { result: previous.result, failed: false, cached: true };
    }
    if (["pending", "running"].includes(previous?.status)) {
      return {
        result: "Shell command is already pending or running for this active run.",
        failed: true,
        blocked: true,
      };
    }
    if (previous?.status === "blocked") {
      return {
        result: previous.result || "Shell command is blocked by the active permission policy.",
        failed: true,
        blocked: true,
        terminal: true,
      };
    }
    if (previous?.status === "failed") {
      const retryReason = String(call.args?.retryReason || "").trim();
      if (previous.attempt >= 2 || !retryReason) {
        return {
          result: previous.attempt >= 2
            ? "Shell command stopped after two attempts without new evidence."
            : "Shell retry requires an explicit retry reason.",
          failed: true,
          blocked: true,
          terminal: previous.attempt >= 2,
        };
      }
      if (previous.testScope === "full" && previous.timedOut) {
        return {
          result: "Full test suite retry requires a concrete cleanup change after the timeout.",
          failed: true,
          blocked: true,
        };
      }
      if (previous.timedOut && requestedTimeout(call.args, this.workspace) <= previous.timeoutMs) {
        return {
          result: `Shell retry requires a timeout longer than ${previous.timeoutMs}ms.`,
          failed: true,
          blocked: true,
        };
      }
    }
    const record = {
      toolCallId: call.id,
      runId: scope.runId,
      turnId: scope.turnId,
      taskEpoch: scope.taskEpoch,
      command: normalizedCommand(call.args?.command),
      cwd: resolve(this.workspace, String(call.args?.workdir || this.workspace)),
      status: "pending",
      attempt: (previous?.attempt || 0) + 1,
      startedAt: null,
      completedAt: null,
      exitCode: null,
      error: "",
      timeoutMs: requestedTimeout(call.args, this.workspace),
      timedOut: false,
      testScope: testExecutionProfile(call.args?.command, resolve(this.workspace, String(call.args?.workdir || this.workspace)))?.scope || null,
      verification: verificationCommand(call.args?.command),
      revision: this.revision,
      result: "",
      signature,
    };
    this.records.set(signature, record);
    return null;
  }

  running(call) {
    const record = this._record(call);
    if (!record || record.status !== "pending") return false;
    record.status = "running";
    record.startedAt = Date.now();
    return true;
  }

  complete(call, result, failed) {
    if (call?.name !== "bash") {
      if (!failed && ["write", "edit", "apply_patch"].includes(call?.name)) this.revision++;
      return;
    }
    const record = this._record(call);
    if (!record || !this._scopeCurrent(record)) return;
    const text = String(result || "");
    const permissionDenied = failed && /Permission (?:denied|rejected):/i.test(text);
    record.status = permissionDenied ? "blocked" : failed ? "failed" : "completed";
    record.completedAt = Date.now();
    record.exitCode = Number(/^Exit:\s*(-?\d+)/im.exec(text)?.[1] ?? (failed ? -1 : 0));
    record.error = failed ? text.split("\n").slice(1).join("\n").trim() : "";
    record.timedOut = /timed out after|did not exit after/i.test(text);
    record.result = text;
    if (!failed && !record.verification) this.revision++;
    record.revision = this.revision;
  }

  _record(call) {
    const scope = this.activeScope;
    if (!scope) return null;
    const record = this.records.get(this._signature(call.args)) || null;
    return record?.toolCallId === call.id ? record : null;
  }

  _scopeCurrent(record) {
    return record.runId === this.activeScope?.runId
      && record.turnId === this.activeScope?.turnId
      && record.taskEpoch === this.activeScope?.taskEpoch;
  }
}
