const CONTEXT_BUDGET = 14_000;
const TOOL_RESULT_EXCERPT = 2_800;
const AICHAT_MODEL = "aichat/claude-haiku-4-5";

function text(value) {
  return String(value ?? "");
}

function toolInstruction(tools) {
  if (!tools.length) return "";
  const definitions = tools.map(tool => ({
    name: tool.function?.name,
    description: text(tool.function?.description),
    parameters: tool.function?.parameters || { type: "object", properties: {} },
  })).filter(tool => tool.name);
  if (!definitions.length) return "";
  return [
    "KHAZAI EXECUTION POLICY:",
    "A concrete URL, path, identifier, or command supplied by the user is enough to begin a safe tool action; do not ask for confirmation or clarification first.",
    "For investigation, retrieve the target first, then inspect concrete public artifacts returned by tools before offering generic advice. Do not substitute an available safe tool action with a suggested next step.",
    "Respect tool constraints and permissions. Do not submit forms, trigger external actions, or invent evidence.",
    "TOOL CALL PROTOCOL:",
    "When a tool is required, respond with exactly one complete minified JSON object or JSON array and no markdown, prose, XML tags, or code fences.",
    "Each call must use {\"tool\":\"name\",\"args\":{...}} with double-quoted keys and valid JSON values. Close every quote, brace, and bracket before ending. Use only these tools:",
    JSON.stringify(definitions),
    "Use a JSON array only for independent read-only calls. Keep write, edit, apply_patch, bash, and permission-gated actions as one call at a time.",
    "Tool results arrive in later user messages. Continue from them without repeating completed calls.",
    "If you cannot produce a complete valid JSON tool call, answer normally instead of emitting partial JSON.",
  ].join("\n");
}

function compactContent(message) {
  const content = text(message.content);
  if (message.role !== "tool" || content.length <= TOOL_RESULT_EXCERPT) return content;
  return `${content.slice(0, TOOL_RESULT_EXCERPT)}\n…(full tool output remains in the KhazAI session)`;
}

function assistantToolCallText(message) {
  if (text(message.content)) return text(message.content);
  const calls = (message.tool_calls || []).flatMap(call => {
    const name = String(call?.function?.name || call?.name || "").trim();
    if (!name) return [];
    let args = call.function?.arguments ?? call.arguments ?? {};
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { return []; }
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) return [];
    return [{ tool: name, args, ...(call.id ? { id: String(call.id) } : {}) }];
  });
  if (!calls.length) return "";
  return JSON.stringify(calls.length === 1 ? calls[0] : calls);
}

function textCompatibleMessage(message) {
  if (message.role === "system") {
    return { role: "user", content: `System instructions:\n${compactContent(message)}` };
  }
  if (message.role === "tool") {
    return {
      role: "user",
      content: `---TOOL RESULT: ${text(message.name || message.tool_call_id || "tool")}---\n${compactContent(message)}`,
    };
  }
  if (message.role === "assistant") {
    return { role: "assistant", content: assistantToolCallText(message) };
  }
  return { role: message.role, content: compactContent(message) };
}

function truncate(message, size) {
  const content = text(message.content);
  if (content.length <= size) return message;
  return { ...message, content: `${content.slice(0, Math.max(0, size - 1))}…` };
}

function takeTail(messages, budget) {
  const latestUser = messages.map(message => message.role).lastIndexOf("user");
  const kept = new Map();
  let used = 0;
  if (latestUser >= 0) {
    const message = messages[latestUser];
    const fitted = truncate(message, Math.max(1, budget));
    kept.set(latestUser, fitted);
    used += text(fitted.content).length;
  }
  for (let index = messages.length - 1; index >= 0; index--) {
    if (kept.has(index)) continue;
    const message = messages[index];
    const remaining = budget - used;
    if (remaining <= 0) continue;
    const fitted = truncate(message, remaining);
    kept.set(index, fitted);
    used += text(fitted.content).length;
  }
  return {
    kept: [...kept.entries()].sort((left, right) => left[0] - right[0]).map(([, message]) => message),
    omitted: messages.filter((_, index) => !kept.has(index)),
  };
}

export function compactAIChatContext(messages, budget = CONTEXT_BUDGET) {
  const limit = Math.max(1_000, Number(budget) || CONTEXT_BUDGET);
  const system = messages.filter(message => message.role === "system");
  const conversation = messages.filter(message => message.role !== "system");
  const systemSize = system.reduce((total, message) => total + text(message.content).length, 0);
  const available = Math.max(1_000, limit - systemSize);
  const conversationSize = conversation.reduce((total, message) => total + text(message.content).length, 0);
  const summaryBudget = conversationSize > available ? Math.min(2_800, Math.floor(available / 5)) : 0;
  const { kept, omitted } = takeTail(conversation, available - summaryBudget);
  if (!omitted.length) return [...system, ...kept];
  const earlier = omitted
    .filter(message => message.role === "user")
    .map(message => text(message.content).slice(0, 800))
    .filter(Boolean)
    .join("\n").slice(0, Math.max(0, summaryBudget - 32));
  const summary = earlier
    ? { role: "user", content: `Earlier conversation summary:\n${earlier}` }
    : null;
  return [...system, ...(summary ? [summary] : []), ...kept];
}

export function prepareAIChatMessages(messages, tools = [], budget = CONTEXT_BUDGET) {
  const protocol = toolInstruction(tools);
  const compatible = messages
    .filter(message => message && ["system", "user", "assistant", "tool"].includes(message.role))
    .map(textCompatibleMessage);
  if (protocol) {
    compatible.push({ role: "user", content: protocol });
  }
  return compactAIChatContext(compatible, budget);
}

export function shouldSteerAIChatToTools({ model, input, reply, hasTools, hasEvidence, attempt }) {
  if (model !== AICHAT_MODEL || !hasTools || hasEvidence || attempt > 0) return false;
  if (!/https?:\/\//i.test(text(input))) return false;
  return /\?|\b(?:can|could|would|should) you\b|\b(?:need|provide|clarify|confirm)\b/i.test(text(reply));
}

export const aichatToolContinuation = "Internal execution correction: the user supplied a concrete URL. Do not ask for clarification or confirmation. Start the safe read-only investigation with one appropriate available tool. Return only one complete JSON tool call with no prose.";

export { CONTEXT_BUDGET, TOOL_RESULT_EXCERPT };
