import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { redactSecrets } from "../lib/secrets.js";
import { normalizeToolOutput } from "./tool-lifecycle.js";

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

function truncateOutput(output, sessionId, callId) {
  const source = redactSecrets(String(output || ""));
  const lines = source.split("\n");
  const bytes = Buffer.byteLength(source);
  if (bytes <= MAX_OUTPUT_BYTES && lines.length <= MAX_OUTPUT_LINES) {
    return { output: source, metadata: {} };
  }
  const path = outputPath(sessionId, callId);
  writeFileSync(path, source, { encoding: "utf-8", mode: 0o600 });
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
  }

  async *_reject(part, call, message, reason = "denied") {
    this.lifecycle.failed(part, message);
    yield { type: "tool-part", part: { ...part } };
    yield { type: "tool-result", tool: call.name, result: part.state.error, callId: part.callId, failed: true };
    yield {
      type: "execution-result",
      call,
      part,
      result: part.state.error,
      failed: true,
      finishReason: reason,
    };
  }

  async *execute(input, extraContext = {}) {
    const call = this.normalizeCall({
      ...input,
      id: input?.id || randomUUID(),
      args: { ...(input?.args || {}) },
    });
    const tool = this.registry.get(call.name);
    const part = this.lifecycle.pending({ callId: call.id, tool: call.name, input: call.args });
    yield { type: "tool-part", part: { ...part, state: { ...part.state } } };
    this.lifecycle.running(part, call.args);
    yield { type: "tool-part", part: { ...part } };
    yield { type: "tool-call", tool: call.name, args: call.args, callId: call.id };

    const invalid = schemaError(tool, call.args);
    if (invalid) {
      yield* this._reject(part, call, tool ? invalid : `Unknown tool "${call.name}".`, "tool-error");
      return;
    }

    const external = this.permissionService.evaluateExternalDirectory(call.name, call.args);
    if (external?.decision === "deny") {
      yield* this._reject(part, call, `Permission denied: external_directory (${external.value})`);
      return;
    }
    if (external?.decision === "ask") {
      yield {
        type: "permission",
        tool: "external_directory",
        args: { path: external.value },
        reason: external.reason,
        pattern: external.value,
        options: ["Allow once", "Always allow", "Reject"],
      };
      let answer = "reject";
      try { answer = await this.permissionHandler?.(external); } catch {}
      if (rejected(answer)) {
        yield* this._reject(part, call, `Permission rejected: external_directory (${external.value})`);
        return;
      }
      if (/always|session/i.test(String(answer))) {
        this.permissionService.allowForSession("external_directory", external.always);
      }
      call.args._allowExternal = true;
    } else if (external?.decision === "allow") {
      call.args._allowExternal = true;
    }

    const permission = this.permissionService.evaluate(call.name, call.args);
    if (permission.decision === "deny") {
      yield* this._reject(part, call, `Permission denied: ${permission.permission} (${permission.value})`);
      return;
    }
    if (permission.decision === "ask") {
      yield {
        type: "permission",
        tool: call.name,
        args: call.args,
        reason: permission.reason,
        pattern: permission.value,
        options: ["Allow once", "Always allow", "Reject"],
      };
      let answer = "reject";
      try { answer = await this.permissionHandler?.(permission); } catch {}
      if (rejected(answer)) {
        yield* this._reject(part, call, `Permission rejected: ${permission.permission} (${permission.value})`);
        return;
      }
      if (/always|session/i.test(String(answer))) {
        this.permissionService.allowForSession(call.name, permission.always);
      }
    }

    call.args = this.prepareArgs(call.name, call.args);
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
      updateMetadata: metadata => this.lifecycle.metadata(part, metadata),
      ...extraContext,
    };
    try {
      const before = await this.registry.trigger("tool.execute.before", context, { args: call.args });
      call.args = before?.args || call.args;
      let raw;
      if (call.name === "question") {
        if (!this.questionHandler) throw new Error("Question rejected: no interactive input is available");
        const question = String(call.args.question || "Please choose an option.").trim();
        const options = Array.isArray(call.args.options) ? call.args.options.map(String).filter(Boolean) : [];
        yield { type: "question", question, options };
        const answer = await this.questionHandler({ question, options });
        raw = {
          title: "Question",
          output: `User answered: ${redactSecrets(String(answer))}`,
          metadata: {},
        };
      } else {
        const execution = Promise.resolve(tool.execute(call.args, { ...context, args: call.args }));
        let timeout;
        const bounded = new Promise((resolve, reject) => {
          timeout = setTimeout(() => reject(new Error(`Tool timed out after ${this.timeoutMs}ms.`)), this.timeoutMs);
          if (this.signal?.aborted) reject(new Error("Tool execution aborted."));
          else this.signal?.addEventListener("abort", () => reject(new Error("Tool execution aborted.")), { once: true });
          execution.then(resolve, reject);
        });
        try {
          raw = await bounded;
        } finally {
          clearTimeout(timeout);
        }
      }
      let output = normalizeToolOutput(raw, call.name);
      output = await this.registry.trigger("tool.execute.after", { ...context, args: call.args }, output);
      const truncated = truncateOutput(output.output, this.sessionId, call.id);
      output = {
        ...output,
        output: truncated.output,
        metadata: { ...(output.metadata || {}), ...truncated.metadata },
      };
      if (this.resultFailed(output.output)) this.lifecycle.failed(part, output.output, output.metadata);
      else this.lifecycle.completed(part, output);
    } catch (error) {
      this.lifecycle.failed(part, redactSecrets(error?.message || String(error)));
    }
    const result = part.state.status === "error" ? part.state.error : part.state.output;
    yield { type: "tool-part", part: { ...part } };
    yield {
      type: "tool-result",
      tool: call.name,
      result,
      callId: call.id,
      failed: part.state.status === "error",
      metadata: part.state.metadata || {},
    };
    yield {
      type: "execution-result",
      call,
      part,
      result,
      failed: part.state.status === "error",
      finishReason: part.state.status === "error" ? "tool-error" : "tool-calls",
    };
  }

  async *executeBatch(inputs, extraContext = {}, concurrency = 4) {
    const results = [];
    const collect = async input => {
      const events = [];
      for await (const event of this.execute(input, extraContext)) events.push(event);
      return events;
    };
    const limit = Math.max(1, Math.min(8, Number(concurrency) || 4));
    for (let index = 0; index < inputs.length; index += limit) {
      results.push(...await Promise.all(inputs.slice(index, index + limit).map(collect)));
    }
    for (const events of results) {
      for (const event of events) yield event;
    }
  }
}

export { MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES };
