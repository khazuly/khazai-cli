import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

const CANONICAL_ROLES = ["system", "user", "assistant", "tool"];
const FRAME_ENTRY_LIMIT = 8;
const PROJECTION_ENTRY_LIMIT = 8;
const TOKEN_ENTRY_LIMIT = 2048;

export const OLD_TOOL_RESULT_MARKER = "[Old tool result cleared after compaction]";

function tokensForLength(length) {
  return Math.max(1, Math.ceil(length / 4));
}

function trimEntries(entries, limit) {
  while (entries.size > limit) {
    entries.delete(entries.keys().next().value);
  }
}

export class ContextCache {
  constructor(state = null, tokenizerProfile = "chars4") {
    this._frames = new Map();
    this._projections = new Map();
    this._messageMeta = new WeakMap();
    this._tokenEntries = new Map();
    this._tokenizerProfile = tokenizerProfile;
    this.stats = {
      metaComputations: 0,
      frameBuilds: 0,
      frameHits: 0,
      fullValidations: 0,
      incrementalValidations: 0,
      projectionBuilds: 0,
      projectionHits: 0,
      toolSchemaBuilds: 0,
    };
    for (const entry of state?.entries || []) {
      if (entry?.key && Number.isFinite(entry.size)) this._tokenEntries.set(entry.key, entry);
    }
    trimEntries(this._tokenEntries, TOKEN_ENTRY_LIMIT);
  }

  reset() {
    this._frames.clear();
    this._projections.clear();
  }

  messageMeta(message) {
    let meta = this._messageMeta.get(message);
    if (meta) return meta;
    const content = String(message?.content ?? "");
    const toolCalls = Array.isArray(message?.tool_calls)
      ? JSON.stringify(message.tool_calls)
      : "[]";
    const contentHash = createHash("sha256")
      .update(content)
      .update("\0")
      .update(toolCalls)
      .digest("hex")
      .slice(0, 16);
    const messageId = String(message?.id || contentHash);
    const key = `${messageId}:${contentHash}:${this._tokenizerProfile}`;
    const persisted = this._tokenEntries.get(key);
    let jsonLength = persisted?.jsonLength;
    let size = persisted?.size;
    if (jsonLength === undefined) {
      jsonLength = JSON.stringify(message || {}).length;
      size = tokensForLength(content.length) + tokensForLength(toolCalls.length);
    }
    meta = {
      key,
      hash: contentHash,
      jsonLength,
      size,
    };
    this._tokenEntries.set(key, { key, size, jsonLength });
    trimEntries(this._tokenEntries, TOKEN_ENTRY_LIMIT);
    this._messageMeta.set(message, meta);
    this.stats.metaComputations++;
    return meta;
  }

  _validateMessage(message, pendingCallIds) {
    if (!message || typeof message !== "object") {
      return { valid: false, issue: "non-message object" };
    }
    const role = message.role;
    if (!CANONICAL_ROLES.includes(role)) {
      return { valid: false, issue: `unsupported role "${String(role)}"` };
    }
    if (role === "assistant") {
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const call of calls) {
        if (!call?.id) return { valid: false, issue: "tool call without an id" };
        try {
          JSON.parse(call.function?.arguments || "{}");
        } catch {
          return { valid: false, issue: "tool call arguments are not valid JSON" };
        }
        pendingCallIds.add(String(call.id));
      }
      return { valid: true, issue: null };
    }
    if (role === "tool") {
      const id = String(message.tool_call_id || "");
      if (id && pendingCallIds.has(id)) {
        pendingCallIds.delete(id);
        return { valid: true, issue: null };
      }
      if (!id) return { valid: false, issue: "tool message without tool_call_id" };
      return { valid: true, issue: null };
    }
    return { valid: true, issue: null };
  }

  buildFrame(key, {
    messages: rawMessages,
    requestStartIndex,
    tailStartIndex = 0,
    limit,
    sys,
    activeObjective,
    summary,
  }) {
    const lastMessage = Array.isArray(rawMessages) ? rawMessages.at(-1) || null : null;
    const existing = this._frames.get(key);
    if (
      existing
      && existing.messageCount === (Array.isArray(rawMessages) ? rawMessages.length : 0)
      && existing.lastMessage === lastMessage
    ) {
      this.stats.frameHits++;
      return existing;
    }

    this.stats.frameBuilds++;
    const lowerBound = Math.max(0, Math.min(Number(tailStartIndex) || 0, rawMessages.length));
    const boundary = Math.max(lowerBound, Math.min(requestStartIndex, rawMessages.length));
    const historical = [];
    const active = [];
    const summaryText = summary ? `Earlier conversation summary:\n${summary}` : "";
    let used = tokensForLength(sys.length)
      + tokensForLength(activeObjective.length)
      + tokensForLength(summaryText);
    const headTokens = used;

    for (let index = boundary; index < rawMessages.length; index++) {
      const message = rawMessages[index];
      if (String(message.content || "").startsWith("[INTERNAL STEERING]")) continue;
      active.push(message);
    }
    if (limit > 0) {
      for (let index = boundary - 1; index >= lowerBound; index--) {
        const message = rawMessages[index];
        if (String(message.content || "").startsWith("[INTERNAL STEERING]")) continue;
        const size = this.messageMeta(message).size;
        if (historical.length > 0 && used + size > limit) break;
        historical.unshift(message);
        used += size;
      }
      while (historical.length > 0 && historical[0]?.role === "tool") {
        const index = boundary - historical.length;
        if (index > lowerBound) historical.unshift(rawMessages[index - 1]);
        else historical.shift();
      }
    }

    const context = [
      { role: "system", content: sys },
      { role: "system", content: activeObjective },
      ...(summary ? [{ role: "assistant", content: `Earlier conversation summary:\n${summary}` }] : []),
      ...historical,
      ...active,
    ];

    return this._frameEntry(key, {
      rawMessages,
      lastMessage,
      boundary,
      historical,
      active,
      sys,
      activeObjective,
      summary,
      headTokens,
    });
  }

  _frameEntry(key, {
    rawMessages,
    lastMessage,
    boundary,
    historical,
    active,
    sys,
    activeObjective,
    summary,
    headTokens = 0,
  }) {
    const context = [
      { role: "system", content: sys },
      { role: "system", content: activeObjective },
      ...(summary ? [{ role: "assistant", content: `Earlier conversation summary:\n${summary}` }] : []),
      ...historical,
      ...active,
    ];

    const wrapperCount = 2 + (summary ? 1 : 0);
    let jsonLength = 2 + 2 * (context.length - 1);
    let wrapperJson = 0;
    for (let index = 0; index < wrapperCount; index++) {
      wrapperJson += JSON.stringify(context[index]).length;
    }
    jsonLength += wrapperJson;
    for (let index = wrapperCount; index < context.length; index++) {
      jsonLength += this.messageMeta(context[index]).jsonLength;
    }
    let hasPlaceholders = false;
    for (let index = 0; index < context.length; index++) {
      const message = context[index];
      if (!hasPlaceholders && String(message.content || "").includes("{{secret:")) {
        hasPlaceholders = true;
      }
    }

    const validationStart = performance.now();
    const issues = [];
    const pendingCallIds = new Set();
    for (let index = 0; index < context.length; index++) {
      const result = this._validateMessage(context[index], pendingCallIds);
      if (!result.valid) issues.push({ index, issue: result.issue });
    }
    const validationMs = performance.now() - validationStart;
    this.stats.fullValidations++;

    const entry = {
      key,
      lastMessage,
      messages: context,
      jsonTokens: tokensForLength(jsonLength),
      payloadBytes: jsonLength,
      messageCount: context.length,
      hasPlaceholders,
      validation: { valid: issues.length === 0, issues },
      validatedUpTo: rawMessages.length,
      pendingCallIds: [...pendingCallIds],
      headTokens,
      stats: {
        validationMs,
        messageCount: context.length,
        payloadBytes: jsonLength,
      },
    };
    this._frames.set(key, entry);
    if (this._frames.size > FRAME_ENTRY_LIMIT) {
      const oldest = this._frames.keys().next().value;
      this._frames.delete(oldest);
    }
    return entry;
  }

  projection(key) {
    const entry = this._projections.get(key);
    if (entry) this.stats.projectionHits++;
    return entry || null;
  }

  setProjection(key, value) {
    this.stats.projectionBuilds++;
    this._projections.set(key, value);
    if (this._projections.size > PROJECTION_ENTRY_LIMIT) {
      const oldest = this._projections.keys().next().value;
      this._projections.delete(oldest);
    }
  }

  exportTokenState() {
    return {
      tokenizerProfile: this._tokenizerProfile,
      entries: [...this._tokenEntries.values()].slice(-2_000),
    };
  }
}
