import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { redactSecrets } from "../lib/secrets.js";
import { shellTimeoutMs } from "../lib/shell-command-policy.js";
import { normalizeToolOutput } from "./tool-lifecycle.js";
import { planToolIsReadOnly } from "./plan-mode.js";

const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2_000;

function schemaError(tool, args) {
  if (!tool) return "Unknown tool.";
  if (!args || typeof args !== "object" || Array.isArray(args)) return "Tool arguments must be an object.";
  if (typeof tool.validate === "function") {
    const result = tool.validate(args);
    if (result === false) return "Tool arguments failed validation.";
    if (result?.success === false) return result.error?.message || "Tool arguments failed validation.";
  }
  const schema = tool.parameters || {};
  for (const name of schema.required || []) {
    if (!Object.hasOwn(args, name)) return `Missing required argument "${name}".`;
  }
  for (const [name, value] of Object.entries(args)) {
    const definition = schema.properties?.[name];
    if (!definition) {
      if (schema.additionalProperties === false && !name.startsWith("_")) return `Argument "${name}" is not allowed.`;
      continue;
    }
    const expected = definition.type;
    if (!expected || name.startsWith("_")) continue;
    const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    if (expected !== actual) return `Argument "${name}" must be ${expected}, received ${actual}.`;
    if (definition.enum && !definition.enum.includes(value)) return `Argument "${name}" is not an allowed value.`;
  }
  return "";
}

function outputPath(sessionId, callId) {
  const directory = join(homedir(), ".local", "share", "khazai-ai", "tool-output", sessionId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return join(directory, `${callId}.txt`);
}

function truncateOutput(output, sessionId, callId, protect, redact) {
  const source = protect(String(output || ""));
  const lines = source.split("\n");
  const bytes = Buffer.byteLength(source);
  if (bytes <= MAX_OUTPUT_BYTES && lines.length <= MAX_OUTPUT_LINES) {
    return { output: source, metadata: {} };
  }
  const path = outputPath(sessionId, callId);
  writeFileSync(path, redact(source), { encoding: "utf-8", mode: 0o600 });
  chmodSync(path, 0o600);
  let visible = lines.slice(0, MAX_OUTPUT_LINES).join("\n");
  if (Buffer.byteLength(visible) > MAX_OUTPUT_BYTES) {
    visible = Buffer.from(visible).subarray(0, MAX_OUTPUT_BYTES).toString("utf-8");
  }
  return {
    output: `${visible}\n[Output truncated; full output: ${path}]`,
    metadata: { truncated: true, outputPath: path, originalBytes: bytes, originalLines: lines.length },
  };
}

function rejected(answer) {
  const value = String(answer || "").toLowerCase();
  return !value.includes("once") && !value.includes("always") && !value.includes("session");
}

function permissionAction(tool, outsideWorkspace = false) {
  const actions = {
    read: "read",
    write: "write",
    edit: "edit",
    apply_patch: "modify files",
    bash: "run a shell command",
    glob: "search",
    grep: "search",
  };
  const action = actions[tool] || `use ${tool}`;
  return outsideWorkspace
    ? `KhazAI wants to ${action} outside the active workspace.`
    : `KhazAI wants to ${action}.`;
}

function permissionTarget(call, request, workspace) {
  if (request.permission === "external_directory" || call.args.path) {
    const path = String(request.value || call.args.path || "");
    return { label: "Path", value: resolve(workspace, path) };
  }
  if (call.name === "bash") return { label: "Command", value: String(call.args.command || "") };
  return { label: "Target", value: String(request.value || "") };
}

export function normalizeQuestionRequest(args = {}) {
  const seen = new Set();
  let recommendationUsed = false;
  const options = (Array.isArray(args.options) ? args.options : []).flatMap((option, index) => {
    const source = typeof option === "string" ? { label: option } : option || {};
    const label = String(source.label || "").trim();
    if (!label) return [];
    const id = String(source.id || `option-${index + 1}`).trim();
    if (seen.has(id)) return [];
    seen.add(id);
    const recommended = Boolean(source.recommended) && !recommendationUsed;
    recommendationUsed ||= recommended;
    return [{
      id,
      label,
      description: String(source.description || "").trim(),
      recommended,
    }];
  });
  if (args.allowCustomAnswer && !seen.has("custom")) {
    options.push({
      id: "custom",
      label: "Enter a custom answer",
      description: "Return to the prompt input and provide a custom response.",
      recommended: false,
      custom: true,
    });
  }
  return {
    questionId: String(args.questionId || "").trim(),
    question: String(args.question || "Please choose an option.").trim(),
    context: String(args.context || "").trim(),
    options,
    allowCustomAnswer: Boolean(args.allowCustomAnswer),
  };
}

export class ToolExecutor {
  constructor({
    registry,
    lifecycle,
    permissionService,
    permissionHandler,
    questionHandler,
    workspace,
    worktree,
    sessionId,
    normalizeCall = value => value,
    prepareArgs = (_tool, args) => args,
    resultFailed = () => false,
    timeoutMs = 60_000,
    signal = null,
    taskContext = null,
    readOnly = false,
    readOnlyMessage = null,
    runId = null,
    turnId = null,
    taskEpoch = null,
    isActiveRun = null,
    authorizeCall = null,
    shellScheduler = null,
    protectOutput = redactSecrets,
    protectData = value => value,
    redactOutput = redactSecrets,
  }) {
    this.registry = registry;
    this.lifecycle = lifecycle;
    this.permissionService = permissionService;
    this.permissionHandler = permissionHandler;
    this.questionHandler = questionHandler;
    this.workspace = workspace;
    this.worktree = worktree || workspace;
    this.sessionId = sessionId;
    this.normalizeCall = normalizeCall;
    this.prepareArgs = prepareArgs;
    this.resultFailed = resultFailed;
    this.timeoutMs = Math.max(250, Number(timeoutMs) || 60_000);
    this.signal = signal;
    this.taskContext = taskContext;
    this.readOnly = Boolean(readOnly);
    this.readOnlyMessage = readOnlyMessage || "Plan Mode is read-only. This tool would modify the workspace.";
    this.runId = runId;
    this.turnId = turnId;
    this.taskEpoch = taskEpoch;
    this.isActiveRun = typeof isActiveRun === "function" ? isActiveRun : null;
    this.authorizeCall = typeof authorizeCall === "function" ? authorizeCall : null;
    this.shellScheduler = shellScheduler;
    this.protectOutput = protectOutput;
    this.protectData = protectData;
    this.redactOutput = redactOutput;
  }

  _approvalRequest(call, permission, outsideWorkspace = false) {
    const target = permissionTarget(call, permission, this.workspace);
    return {
      ...permission,
      runId: this.runId,
      turnId: this.turnId,
      taskEpoch: this.taskEpoch,
      callId: call.id,
      tool: call.name,
      pattern: permission.value,
      action: permissionAction(call.name, outsideWorkspace),
      target,
      options: [
        "Allow once",
        target.label === "Path" ? "Always allow this path" : "Always allow this action",
        "Reject",
      ],
    };
  }

  _scoped(event) {
    return { ...event, runId: this.runId, turnId: this.turnId, taskEpoch: this.taskEpoch };
  }

  _isActive() {
    return !this.signal?.aborted
      && (!this.isActiveRun || this.isActiveRun({
        runId: this.runId,
        turnId: this.turnId,
        taskEpoch: this.taskEpoch,
      }));
  }

  _recordApproval(call, permission, source) {
    this.permissionService.recordApproval({
      tool: call.name,
      permission: permission.permission,
      value: this.protectOutput(permission.value),
      source,
    });
  }

  async *_reject(part, call, message, reason = "denied") {
    this.lifecycle.failed(part, message);
    this.shellScheduler?.complete(call, part.state.error, true);
    yield this._scoped({ type: "tool-part", part: { ...part } });
    yield this._scoped({ type: "tool-result", tool: call.name, result: part.state.error, callId: part.callId, failed: true });
    yield this._scoped({
      type: "execution-result",
      call,
      part,
      result: part.state.error,
      failed: true,
      finishReason: reason,
    });
  }

  async *_unknown(call) {
    const error = this.registry.unknownToolError(call.name);
    const result = JSON.stringify(error);
    const part = this.lifecycle.invalid({
      callId: call.id,
      requestedTool: call.name,
      input: this.protectData(call.args),
      error: result,
      metadata: error,
    });
    yield this._scoped({ type: "tool-part", part: { ...part } });
    yield this._scoped({
      type: "tool-result",
      tool: "unknown_tool",
      result,
      callId: part.callId,
      failed: true,
      metadata: error,
    });
    yield this._scoped({
      type: "execution-result",
      call,
      part,
      result,
      failed: true,
      finishReason: "tool-error",
    });
  }

  async *execute(input, extraContext = {}) {
    if (!this._isActive()) return;
    let call = this.normalizeCall({
      ...input,
      id: input?.id || randomUUID(),
      args: { ...(input?.args || {}) },
    });
    const canonicalName = this.registry.resolveName?.(call.name);
    if (canonicalName && canonicalName !== call.name) call = { ...call, name: canonicalName };
    if (this.authorizeCall && !this.authorizeCall(call)) return;
    const tool = this.registry.get(call.name);
    if (!tool) {
      yield* this._unknown(call);
      return;
    }
    if (this.readOnly && !planToolIsReadOnly(call, tool)) {
      const part = this.lifecycle.invalid({
        callId: call.id,
        requestedTool: call.name,
        input: this.protectData(call.args),
        error: this.readOnlyMessage,
        metadata: {
          runId: this.runId,
          turnId: this.turnId,
          taskEpoch: this.taskEpoch,
          blocked: true,
          hidden: true,
          planDenied: true,
        },
      });
      this.shellScheduler?.complete(call, this.readOnlyMessage, true);
      yield this._scoped({ type: "tool-part", part: { ...part, state: { ...part.state } } });
      yield this._scoped({
        type: "tool-result",
        tool: call.name,
        result: this.readOnlyMessage,
        callId: call.id,
        failed: true,
        blocked: true,
        metadata: { hidden: true, planDenied: true },
      });
      yield this._scoped({
        type: "execution-result",
        call,
        part,
        result: this.readOnlyMessage,
        failed: true,
        finishReason: "blocked",
      });
      return;
    }
    const part = this.lifecycle.pending({
      callId: call.id,
      tool: call.name,
      input: this.protectData(call.args),
      metadata: { runId: this.runId, turnId: this.turnId, taskEpoch: this.taskEpoch },
    });
    yield this._scoped({ type: "tool-part", part: { ...part, state: { ...part.state } } });
    if (!this._isActive()) return;

    const external = this.permissionService.evaluateExternalDirectory(call.name, call.args);
    if (external?.decision === "deny") {
      yield* this._reject(part, call, `Permission denied: external_directory (${external.value})`);
      return;
    }
    if (external?.decision === "ask") {
      const request = this._approvalRequest(call, external, true);
      yield this._scoped({
        type: "permission",
        ...request,
      });
      if (!this._isActive()) return;
      let answer = "reject";
      try { answer = await this.permissionHandler?.(request); } catch {}
      if (!this._isActive()) return;
      if (rejected(answer)) {
        yield* this._reject(part, call, `Permission rejected: external_directory (${external.value})`);
        return;
      }
      if (/always/i.test(String(answer))) {
        await this.permissionService.allowAlways("external_directory", request.target.value);
        this._recordApproval(call, external, "persisted");
      } else {
        this._recordApproval(call, external, /session/i.test(String(answer)) ? "session" : "user");
        if (/session/i.test(String(answer))) {
          this.permissionService.allowForSession("external_directory", external.always);
        }
      }
      call.args._allowExternal = true;
    } else if (external?.decision === "allow") {
      if (external.source === "auto" || external.source === "persisted") {
        this._recordApproval(call, external, external.source === "auto" ? "allow-all" : "persisted");
      }
      call.args._allowExternal = true;
    }

    const permission = this.permissionService.evaluate(call.name, call.args);
    if (permission.decision === "deny") {
      yield* this._reject(part, call, `Permission denied: ${permission.permission} (${permission.value})`);
      return;
    }
    if (permission.decision === "ask") {
      const request = this._approvalRequest(call, permission);
      yield this._scoped({
        type: "permission",
        ...request,
      });
      if (!this._isActive()) return;
      let answer = "reject";
      try { answer = await this.permissionHandler?.(request); } catch {}
      if (!this._isActive()) return;
      if (rejected(answer)) {
        yield* this._reject(part, call, `Permission rejected: ${permission.permission} (${permission.value})`);
        return;
      }
      if (/always/i.test(String(answer))) {
        if (request.target.label === "Path") {
          await this.permissionService.allowAlways(permission.permission, request.target.value);
          this._recordApproval(call, permission, "persisted");
        } else {
          this._recordApproval(call, permission, "session");
          this.permissionService.allowForSession(call.name, permission.always);
        }
      } else {
        this._recordApproval(call, permission, "user");
      }
    } else if (permission.source === "auto" || permission.source === "allow-all") {
      this._recordApproval(call, permission, "allow-all");
    } else if (permission.source === "persisted") {
      this._recordApproval(call, permission, "persisted");
    }

    if (!this._isActive()) return;
    this.lifecycle.running(part, this.protectData(call.args));
    this.shellScheduler?.running(call);
    yield this._scoped({ type: "tool-part", part: { ...part, state: { ...part.state } } });
    if (!this._isActive()) return;
    call.args = this.prepareArgs(call.name, call.args);
    if (call.name === "bash") {
      call.args.timeout = shellTimeoutMs(
        call.args.command,
        call.args.workdir || this.workspace,
        call.args.timeout,
      ) / 1_000;
    }
    const context = {
      tool: call.name,
      sessionId: this.sessionId,
      sessionID: this.sessionId,
      messageId: this.lifecycle.messageId,
      messageID: this.lifecycle.messageId,
      callId: call.id,
      callID: call.id,
      directory: this.workspace,
      worktree: this.worktree,
      ask: request => this.permissionHandler?.(request),
      permissionService: this.permissionService,
      abortSignal: this.signal,
      signal: this.signal,
      runId: this.runId,
      turnId: this.turnId,
      taskEpoch: this.taskEpoch,
      isActiveRun: scope => !this.isActiveRun || this.isActiveRun(scope),
      updateMetadata: metadata => this._isActive() && this.lifecycle.metadata(part, metadata),
      ...extraContext,
    };
    try {
      const before = await this.registry.trigger("tool.execute.before", context, { args: call.args });
      if (!this._isActive()) return;
      call.args = before?.args || call.args;
      let raw;
      if (call.name === "question") {
        if (!this.questionHandler) throw new Error("Question rejected: no interactive input is available");
        const request = normalizeQuestionRequest(call.args);
        yield this._scoped({ type: "question", ...request });
        if (!this._isActive()) return;
        const answer = await this.questionHandler(request);
        if (!this._isActive()) return;
        raw = {
          title: "Question",
          output: `User answered: ${this.protectOutput(String(answer?.label || answer))}`,
          metadata: {},
        };
      } else {
        const executionController = new AbortController();
        const requestedShellTimeout = call.name === "bash"
          ? (Number(call.args.timeout) > 0 ? Number(call.args.timeout) : 60) * 1000 + 1_000
          : 0;
        const timeoutMs = Math.max(250, Number(tool.timeoutMs) || this.timeoutMs, requestedShellTimeout);
        const abortExecution = () => executionController.abort(this.signal?.reason);
        this.signal?.addEventListener("abort", abortExecution, { once: true });
        const execution = Promise.resolve(tool.execute(call.args, {
          ...context,
          args: call.args,
          abortSignal: executionController.signal,
          signal: executionController.signal,
        }));
        let timeout;
        let abortBounded;
        const bounded = new Promise((resolve, reject) => {
          timeout = setTimeout(() => {
            executionController.abort();
            reject(new Error(`Tool timed out after ${timeoutMs}ms.`));
          }, timeoutMs);
          abortBounded = () => reject(new Error("Tool execution aborted."));
          if (this.signal?.aborted) abortBounded();
          else this.signal?.addEventListener("abort", abortBounded, { once: true });
          execution.then(resolve, reject);
        });
        try {
          raw = await bounded;
        } finally {
          clearTimeout(timeout);
          this.signal?.removeEventListener("abort", abortExecution);
          this.signal?.removeEventListener("abort", abortBounded);
        }
      }
      if (!this._isActive()) return;
      let output = normalizeToolOutput(raw, call.name);
      output = await this.registry.trigger("tool.execute.after", { ...context, args: call.args }, output);
      if (!this._isActive()) return;
      const truncated = truncateOutput(
        output.output,
        this.sessionId,
        call.id,
        this.protectOutput,
        this.redactOutput,
      );
      output = {
        ...output,
        output: truncated.output,
        metadata: this.protectData({ ...(output.metadata || {}), ...truncated.metadata }),
      };
      if (this.resultFailed(output.output)) this.lifecycle.failed(part, output.output, output.metadata);
      else this.lifecycle.completed(part, output);
    } catch (error) {
      if (!this._isActive()) return;
      this.lifecycle.failed(part, this.protectOutput(error?.message || String(error)));
    }
    if (!this._isActive()) return;
    const result = part.state.status === "error" ? part.state.error : part.state.output;
    this.shellScheduler?.complete(call, result, part.state.status === "error");
    if (this.taskContext?.recordToolExecution) {
      this.taskContext.recordToolExecution(call.name, call.args, result, part.state.status === "error");
    }
    yield this._scoped({ type: "tool-part", part: { ...part } });
    yield this._scoped({
      type: "tool-result",
      tool: call.name,
      result,
      callId: call.id,
      failed: part.state.status === "error",
      metadata: part.state.metadata || {},
    });
    yield this._scoped({
      type: "execution-result",
      call,
      part,
      result,
      failed: part.state.status === "error",
      finishReason: part.state.status === "error" ? "tool-error" : "tool-calls",
    });
  }

}

export { MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES };
