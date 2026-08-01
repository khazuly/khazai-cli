import { countTokens } from "./tokens.js";
import { normalizeMessages, normalizeTools, filterRequestOptions, sanitizeToolJsonSchema } from "./provider-adapter.js";


const CANONICAL_ROLES = ["system", "user", "assistant", "tool"];

export function validateMessageSequence(messages = []) {
  const issues = [];
  const accepted = [];
  const pendingToolCallIds = new Set();
  const seenToolResults = new Set();
  let lastRole = null;

  for (const raw of messages) {
    if (!raw || typeof raw !== "object") {
      issues.push({ code: "UI_ONLY_MESSAGE", message: "Dropped non-message object" });
      continue;
    }
    const role = raw.role;
    if (!CANONICAL_ROLES.includes(role)) {
      issues.push({ code: "UNSUPPORTED_ROLE", message: `Dropped message with unsupported role "${String(role)}"` });
      continue;
    }
    if (role === "assistant" && Array.isArray(raw.tool_calls) && !raw.tool_calls.length && !raw.content) {
      issues.push({ code: "EMPTY_ASSISTANT", message: "Dropped empty assistant message" });
      continue;
    }
    if (role === "tool") {
      const id = String(raw.tool_call_id || "");
      if (!pendingToolCallIds.has(id)) {
        issues.push({ code: "ORPHAN_TOOL_RESULT", message: "Dropped tool result without a preceding assistant tool call" });
        continue;
      }
      if (seenToolResults.has(id)) {
        issues.push({ code: "DUPLICATE_TOOL_RESULT", message: "Dropped duplicate tool result" });
        continue;
      }
      seenToolResults.add(id);
      accepted.push({ ...raw, content: String(raw.content ?? "") });
      lastRole = role;
      continue;
    }
    if (role === "assistant" && Array.isArray(raw.tool_calls)) {
      const calls = raw.tool_calls.filter(call => {
        if (!call?.id || pendingToolCallIds.has(call.id)) return false;
        try {
          JSON.parse(call.function?.arguments || "{}");
          return true;
        } catch {
          return false;
        }
      });
      if (!calls.length) {
        if (!raw.content) {
          issues.push({ code: "INCOMPLETE_TOOL_CALL", message: "Dropped assistant message with invalid tool arguments" });
          continue;
        }
        accepted.push({ ...raw, content: String(raw.content ?? ""), tool_calls: [] });
      } else {
        for (const call of calls) pendingToolCallIds.add(call.id);
        accepted.push({ ...raw, tool_calls: calls, content: raw.content ?? null });
      }
      lastRole = role;
      continue;
    }
    accepted.push({ ...raw });
    lastRole = role;
  }
  return { messages: accepted, issues, valid: issues.length === 0 };
}

export function transformOptions(options = {}, capabilities = {}) {
  return filterRequestOptions(options, capabilities);
}

export function transformTools(tools = [], capabilities = {}, compatibility = {}) {
  return normalizeTools(tools, capabilities, compatibility);
}

export function buildRequestSnapshot({ messages, tools, options, capabilities, compatibility, adapter }) {
  const providerMessages = adapter
    ? adapter.normalizeMessages(messages, capabilities)
    : normalizeMessages(messages, capabilities, compatibility);
  const providerTools = adapter
    ? adapter.normalizeTools(tools, capabilities)
    : normalizeTools(tools, capabilities, compatibility);
  const filteredOptions = filterRequestOptions(options, capabilities);
  return { providerMessages, providerTools, filteredOptions };
}

export function estimateSnapshotTokens(snapshot) {
  let tokens = 0;
  try {
    tokens += countTokens(JSON.stringify(snapshot.providerMessages || []));
  } catch {}
  try {
    tokens += countTokens(JSON.stringify(snapshot.providerTools || []));
  } catch {}
  return tokens;
}

export function effectiveContextLimit({ capabilities, modelRegistry, config }) {
  const fromCapabilities = capabilities?.contextLimit || capabilities?.context_window || null;
  if (fromCapabilities) return Number(fromCapabilities);
  if (modelRegistry?.contextLimit) return Number(modelRegistry.contextLimit);
  if (config?.contextLimit) return Number(config.contextLimit);
  if (config?.tokenBudget) return null;
  return null;
}

export function preflightContext({
  messages,
  tools = [],
  options = {},
  capabilities = {},
  compatibility = {},
  adapter,
  contextLimit = null,
  compactThreshold = 0.9,
  onCompact = null,
} = {}) {
  let snapshot = buildRequestSnapshot({ messages, tools, options, capabilities, compatibility, adapter });
  let projectedTokens = estimateSnapshotTokens(snapshot);
  const limit = effectiveContextLimit({ capabilities, config: { contextLimit } }) || Number(contextLimit) || null;
  const threshold = limit ? limit * compactThreshold : null;
  let compacted = false;
  if (threshold !== null && projectedTokens > threshold && typeof onCompact === "function") {
    const rebuilt = onCompact(messages, { projectedTokens, limit, threshold });
    if (rebuilt && Array.isArray(rebuilt.messages)) {
      messages = rebuilt.messages;
      snapshot = buildRequestSnapshot({ messages, tools, options, capabilities, compatibility, adapter });
      projectedTokens = estimateSnapshotTokens(snapshot);
      compacted = true;
    }
  }
  const validated = validateMessageSequence(snapshot.providerMessages);
  return {
    messages,
    snapshot,
    projectedTokens,
    contextLimit: limit,
    ratio: limit ? projectedTokens / limit : null,
    compacted,
    valid: validated.valid,
    validationIssues: validated.issues,
  };
}

export { sanitizeToolJsonSchema };
