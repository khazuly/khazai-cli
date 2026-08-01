import { normalizeIntentContract } from "../../intent-resolver.js";
export { delimiterCount, proseLooksIncomplete } from "../../../lib/interactive-text.js";

export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isProviderParseFailure(text) {
  return /(?:i\s+(?:could not|couldn't|cannot)\s+parse\s+(?:the\s+)?response|failed\s+to\s+parse\s+(?:the\s+)?response|invalid\s+(?:tool\s+call|response\s+format)|response\s+(?:was\s+)?not\s+parseable)/i.test(String(text || ""));
}

export function isShortContinuation(input) {
  return /^(?:yes|continue|go ahead|fix|ok|use this)$/i.test(String(input || "").trim());
}

export function isNegativeContinuation(input) {
  return /^(?:no|cancel)$/i.test(String(input || "").trim());
}

export function pendingActionState(contract, activeTask, {
  status = "active",
  offeredAction = "",
  reason = "",
  nextStep = "",
  evidence = [],
  gitPush = null,
} = {}) {
  return {
    version: 1,
    status,
    contract: normalizeIntentContract(contract, activeTask?.goal || contract?.request || ""),
    activeTask: { ...(activeTask || {}) },
    goal: String(activeTask?.goal || contract?.request || ""),
    targetFiles: [...new Set(activeTask?.targetFiles || [])],
    offeredAction: String(offeredAction || ""),
    reason: String(reason || ""),
    nextStep: String(nextStep || activeTask?.nextExpectedAction || ""),
    acceptanceCriteria: [...new Set(activeTask?.acceptanceCriteria || contract?.requiredEvidence || [])],
    evidence: Array.isArray(evidence) ? evidence.map(entry => ({ ...entry, args: { ...(entry.args || {}) } })) : [],
    gitPush: gitPush?.command ? { command: String(gitPush.command) } : null,
  };
}

export function offeredModificationContract(task, reply) {
  const goal = `${task?.goal || ""}\n${reply || ""}`;
  return normalizeIntentContract({
    ...task?.contract,
    intent: "change",
    category: "MODIFICATION",
    operation: "modify",
    requiredEvidence: ["mutation"],
    modifiesFiles: true,
  }, goal);
}

export function offersFollowUpAction(reply) {
  return /(?:should|would you like|can i)\s+(?:i\s+)?(?:fix|patch|edit|continue)|(?:should i|would you like me to)\b/i.test(String(reply || ""));
}

export function taskState(contract, goal) {
  const targets = [...new Set(String(goal || "").match(/(?:[\w.-]+\/)*[\w.-]+\.(?:js|mjs|cjs|ts|tsx|py|json|md|css|html|sh)\b/gi) || [])];
  return {
    activeIntent: contract.category || contract.intent,
    goal: String(goal || ""), targetFiles: targets, pendingProblem: "", lastToolResult: "",
    nextExpectedAction: "determine the next action from task evidence",
    acceptanceCriteria: contract.requiredEvidence || [], evidenceNeeded: contract.requiredEvidence || [],
  };
}
export function extractJsonCandidates(text) {
  const source = String(text);
  const candidates = [];

  for (let start = 0; start < source.length; start++) {
    if (source[start] !== "{" && source[start] !== "[") continue;

    const stack = [];
    let inString = false;
    let escaped = false;
    let complete = false;

    for (let index = start; index < source.length; index++) {
      const character = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }

      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === "{" || character === "[") {
        stack.push(character);
        continue;
      }
      if (character !== "}" && character !== "]") continue;

      const opening = stack.pop();
      const matches = (opening === "{" && character === "}")
        || (opening === "[" && character === "]");
      if (!matches) break;
      if (stack.length === 0) {
        candidates.push(source.slice(start, index + 1));
        start = index;
        complete = true;
        break;
      }
    }
    if (!complete) continue;
  }

  return candidates;
}

export function decodeXmlEntities(value) {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function coerceTaggedArgument(value, schema = {}) {
  const decoded = decodeXmlEntities(value).trim();
  if (schema.type === "number") {
    const number = Number(decoded);
    return Number.isFinite(number) ? number : decoded;
  }
  if (schema.type === "boolean") return decoded.toLowerCase() === "true";
  if (schema.type === "array" || schema.type === "object") {
    try { return JSON.parse(decoded); } catch { return schema.type === "array" ? [decoded] : decoded; }
  }
  return decoded;
}

export function extractTaggedToolCall(text, registry) {
  const source = String(text);
  const names = registry.list().map(tool => tool.name);
  const isRegistered = name => names.includes(name);
  const invocations = [
    ...source.matchAll(/<invoke\b([^>]*)>([\s\S]*?)<\/invoke>/gi),
    ...source.matchAll(/<tool_call\b([^>]*)>([\s\S]*?)<\/tool_call>/gi),
  ];

  for (const invocation of invocations) {
    const attributes = invocation[1] || "";
    const body = invocation[2] || "";
    const name = /\b(?:name|tool)\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1]
      || /<(?:tool_name|name)>\s*([^<]+?)\s*<\/(?:tool_name|name)>/i.exec(body)?.[1]?.trim();
    if (!name || !isRegistered(name)) continue;

    const tool = registry.get(name);
    const properties = tool?.parameters?.properties || {};
    const args = {};
    const argumentsBlock = /<arguments?>\s*([\s\S]*?)\s*<\/arguments?>/i.exec(body)?.[1];
    if (argumentsBlock) {
      try {
        const parsed = JSON.parse(decodeXmlEntities(argumentsBlock));
        if (isObject(parsed)) return { name, args: parsed };
      } catch {}
    }
    const inlineJson = extractJsonCandidates(body).find(value => value.trimStart().startsWith("{"));
    if (inlineJson) {
      try {
        const parsed = JSON.parse(inlineJson);
        if (isObject(parsed)) return { name, args: parsed };
      } catch {}
    }

    for (const parameter of body.matchAll(/<parameter\b([^>]*)>([\s\S]*?)<\/parameter>/gi)) {
      const parameterName = /\bname\s*=\s*["']([^"']+)["']/i.exec(parameter[1] || "")?.[1];
      if (parameterName && Object.hasOwn(properties, parameterName)) {
        args[parameterName] = coerceTaggedArgument(parameter[2], properties[parameterName]);
      }
    }
    for (const [parameterName, schema] of Object.entries(properties)) {
      if (Object.hasOwn(args, parameterName)) continue;
      const escapedName = parameterName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = new RegExp(`<${escapedName}>\\s*([\\s\\S]*?)\\s*<\\/${escapedName}>`, "i").exec(body);
      if (match) args[parameterName] = coerceTaggedArgument(match[1], schema);
    }
    if (Object.keys(args).length > 0) return { name, args };
  }

  for (const name of names) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const call = new RegExp(`(?:^|\\n)\\s*(?:tool\\s*:\\s*)?${escapedName}\\s*\\(`, "i").exec(source);
    if (!call) continue;
    const tail = source.slice(call.index + call[0].length);
    const candidate = extractJsonCandidates(tail).find(value => value.trimStart().startsWith("{"));
    if (!candidate) continue;
    try {
      const args = JSON.parse(candidate);
      if (isObject(args)) return { name, args };
    } catch {}
  }

  const labeled = /(?:^|\n)\s*tool\s*:\s*([a-z][\w-]*)[^\n]*\n\s*(?:args?|arguments?|parameters?)\s*:\s*/i.exec(source);
  if (labeled && isRegistered(labeled[1])) {
    const tail = source.slice(labeled.index + labeled[0].length);
    const candidate = extractJsonCandidates(tail).find(value => value.trimStart().startsWith("{"));
    if (candidate) {
      try {
        const args = JSON.parse(candidate);
        if (isObject(args)) return { name: labeled[1], args };
      } catch {}
    }
  }
  return null;
}

export function extractProseBeforeTool(text, tool = null) {
  const source = String(text || "");
  const boundaries = [];
  const tagged = /<(?:function_calls?|tool_calls?|tool_call|invoke)\b/i.exec(source);
  if (tagged) boundaries.push(tagged.index);
  const name = String(tool?.name || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (name) {
    const invocation = new RegExp(`(?:^|\\n)\\s*(?:tool\\s*:\\s*)?${name}\\s*\\(`, "i").exec(source);
    if (invocation) boundaries.push(invocation.index);
  }
  for (const candidate of extractJsonCandidates(source)) {
    try {
      const value = JSON.parse(candidate);
      const candidateName = value?.tool || value?.function?.name || value?.name;
      if (candidateName === tool?.name) boundaries.push(source.indexOf(candidate));
    } catch {}
  }
  const boundary = boundaries.length ? Math.min(...boundaries) : source.length;
  return source.slice(0, boundary).trimEnd();
}
export const LEGACY_PROTOCOL_HOLDBACK = 160;
export const MAX_PROSE_CONTINUATIONS = 2;
export function jsonCompletion(text) {
  const source = String(text || "");
  const stack = [];
  let inString = false;
  let escaped = false;
  for (const character of source) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; continue; }
    if (character === "{" || character === "[") { stack.push(character); continue; }
    if (character === "}" || character === "]") {
      const opening = stack.pop();
      if (!opening || (opening === "{" && character !== "}") || (opening === "[" && character !== "]")) {
        return "malformed";
      }
    }
  }
  return inString || stack.length ? "truncated" : "complete";
}

export function validateToolArguments(tool, registry) {
  const registered = registry.get(tool?.name);
  if (!registered) return { kind: "unknown_tool", detail: "requested tool is not registered" };
  if (!isObject(tool.args)) return { kind: "schema_validation", detail: "args must be a JSON object" };
  const schema = registered.parameters || {};
  for (const key of schema.required || []) {
    if (!Object.hasOwn(tool.args, key) || tool.args[key] === undefined || tool.args[key] === null) {
      return { kind: "missing_required_argument", detail: `missing required argument \"${key}\"` };
    }
  }
  for (const [key, value] of Object.entries(tool.args)) {
    const definition = schema.properties?.[key];
    if (!definition) {
      if (schema.additionalProperties === false && !["_agentWorkspace", "_allowExternal"].includes(key)) {
        return { kind: "schema_validation", detail: `argument \"${key}\" is not allowed` };
      }
      continue;
    }
    const type = definition.type;
    const matches = !type
      || (type === "string" && typeof value === "string")
      || (type === "number" && typeof value === "number" && Number.isFinite(value))
      || (type === "boolean" && typeof value === "boolean")
      || (type === "array" && Array.isArray(value))
      || (type === "object" && isObject(value));
    if (!matches) return { kind: "schema_validation", detail: `argument \"${key}\" must be ${type}` };
    if (definition.enum && !definition.enum.includes(value)) {
      return { kind: "schema_validation", detail: `argument \"${key}\" is not an allowed value` };
    }
  }
  return null;
}

export function stripMarkdown(text) {
  return String(text || "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/^#+\s+/gm, "");
}

export function joinProseContinuation(prefix, continuation) {
  const left = String(prefix || "");
  const right = String(continuation || "");
  if (!left) return right;
  if (!right) return left;
  const repeatedAt = right.indexOf(left);
  if (repeatedAt !== -1) return left + right.slice(repeatedAt + left.length);
  const maximumOverlap = Math.min(left.length, right.length);
  for (let size = maximumOverlap; size > 0; size--) {
    if (left.slice(-size) === right.slice(0, size)) return left + right.slice(size);
  }
  return left + right;
}
