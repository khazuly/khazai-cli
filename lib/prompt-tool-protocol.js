function parseArguments(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function serializedCall(call) {
  return JSON.stringify({
    tool: String(call?.function?.name || ""),
    args: parseArguments(call?.function?.arguments),
    id: String(call?.id || ""),
  });
}

function convertedMessage(message) {
  if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
    const calls = message.tool_calls.map(serializedCall).join("\n");
    const content = String(message.content || "").trim();
    return { role: "assistant", content: content ? `${content}\n${calls}` : calls };
  }
  if (message.role === "tool") {
    return {
      role: "user",
      content: `Tool result for ${message.name || "tool"} (${message.tool_call_id || "unknown"}):\n${message.content || ""}`,
    };
  }
  return message;
}

function publicTool(tool) {
  return {
    name: String(tool.function?.name || ""),
    description: String(tool.function?.description || ""),
    parameters: tool.function?.parameters || { type: "object", properties: {} },
  };
}

const SAFE_TOOL_ALIASES = new Map([
  ["bash", "bash"],
  ["terminal", "bash"],
  ["glob", "glob"],
  ["grep", "grep"],
]);

const INVALID_TOOL_CALL = "[×] Invalid KhazAI tool call.";

const REASONING_TAG_PATTERNS = [
  /<(?:antThinking|thinking|analysis)\b[^>]*>[\s\S]*?<\/(?:antThinking|thinking|analysis)>\s*/gi,
  /<(?:antThinking|thinking|analysis)\b[^>]*>[\s\S]*$/gi,
];

function stripReasoningTags(text) {
  let value = String(text || "");
  for (const pattern of REASONING_TAG_PATTERNS) value = value.replace(pattern, "");
  return value.trim();
}

function decodeXmlEntities(value) {
  return String(value ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&");
}

function canonicalToolName(name) {
  const requested = String(name || "").trim();
  return SAFE_TOOL_ALIASES.get(requested.toLowerCase()) || requested;
}

function convertLlmProxyArgs(name, args) {
  const converted = { ...(args || {}) };
  if (name === "bash") {
    if (converted.command === undefined && converted.cmd !== undefined) converted.command = converted.cmd;
    if (converted.workdir === undefined && converted.cwd !== undefined) converted.workdir = converted.cwd;
    if (converted.workdir === undefined && converted.directory !== undefined) converted.workdir = converted.directory;
    delete converted.cmd;
    delete converted.cwd;
    delete converted.directory;
  }
  if (name === "glob" || name === "grep") {
    if (converted.path === undefined && converted.dir !== undefined) converted.path = converted.dir;
    if (converted.path === undefined && converted.directory !== undefined) converted.path = converted.directory;
    delete converted.dir;
    delete converted.directory;
  }
  return converted;
}

function stableCallId(requestId, index = 0) {
  const suffix = String(requestId || "call").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return `llmproxy_${suffix || "call"}_${index}`;
}

function normalizedTool(name, args, id, requestId, index = 0) {
  const requested = String(name || "").trim();
  if (!requested || !args || typeof args !== "object" || Array.isArray(args)) return null;
  const canonical = canonicalToolName(requested);
  return {
    tool: canonical,
    args: convertLlmProxyArgs(canonical, args),
    id: String(id || stableCallId(requestId, index)),
  };
}

function parsedArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function argsFromXmlBlock(value) {
  const raw = String(value ?? "").trim().replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/i, "$1");
  if (!raw) return {};
  const parsed = parsedArguments(raw);
  if (parsed) return parsed;
  const decoded = parsedArguments(decodeXmlEntities(raw));
  if (decoded) return decoded;
  return null;
}

function argsFromElements(body) {
  const args = {};
  const element = /<([a-zA-Z_][\w.-]*)\b[^>]*>([\s\S]*?)<\/\1>/g;
  let match;
  while ((match = element.exec(body)) !== null) {
    const key = match[1];
    const inner = String(match[2] ?? "").trim();
    const value = /<[a-zA-Z_]/.test(inner) ? argsFromElements(inner) : decodeXmlEntities(inner);
    if (Object.hasOwn(args, key)) {
      args[key] = Array.isArray(args[key]) ? [...args[key], value] : [args[key], value];
    } else {
      args[key] = value;
    }
  }
  return args;
}

function toolArgsFromBody(body) {
  const block = /<(?:args?|arguments?)\b[^>]*>([\s\S]*?)<\/(?:args?|arguments?)>/i.exec(body);
  if (block) {
    const args = argsFromXmlBlock(block[1]);
    if (args) return args;
    const elements = argsFromElements(block[1]);
    if (Object.keys(elements).length) return elements;
    return null;
  }
  const elements = argsFromElements(body);
  if (Object.keys(elements).length) return elements;
  const inline = /{[\s\S]*}/.exec(body);
  if (inline) {
    const args = argsFromXmlBlock(inline[0]);
    if (args) return args;
  }
  return body.trim() ? {} : null;
}

function parsedFunctionsXml(source, requestId) {
  const blocks = [...String(source).matchAll(/<function\b([^>]*)>([\s\S]*?)<\/function>/gi)];
  if (!blocks.length) return null;
  const tools = [];
  for (const [index, match] of blocks.entries()) {
    const attributes = match[1] || "";
    const body = match[2] || "";
    const name = /<name>\s*([^<>]+?)\s*<\/name>/i.exec(body)?.[1]?.trim()
      || /\b(?:name|tool)\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1];
    const argsBlock = /<(?:args?|arguments?)\b[^>]*>([\s\S]*?)<\/(?:args?|arguments?)>/i.exec(body);
    const args = argsBlock ? argsFromXmlBlock(argsBlock[1]) : null;
    if (args === null) return null;
    const tool = normalizedTool(name, args, null, requestId, index);
    if (!tool) return null;
    tools.push(tool);
  }
  return tools;
}

function parsedToolsXml(source, requestId) {
  const blocks = [...String(source).matchAll(/<tool\b([^>]*)>([\s\S]*?)<\/tool>/gi)];
  if (!blocks.length) return null;
  const tools = [];
  for (const [index, match] of blocks.entries()) {
    const attributes = match[1] || "";
    let body = match[2] || "";
    const name = /\b(?:name|tool)\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1]
      || /<name>\s*([^<>]+?)\s*<\/name>/i.exec(body)?.[1]?.trim();
    if (name && /<name>\s*[^<>]+?\s*<\/name>/i.test(body)) {
      body = body.replace(/<name>\s*[^<>]+?\s*<\/name>/gi, "");
    }
    const args = toolArgsFromBody(body);
    if (args === null) return null;
    const tool = normalizedTool(name, args, null, requestId, index);
    if (!tool) return null;
    tools.push(tool);
  }
  return tools;
}

function parsedJsonCalls(parsed, requestId) {
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const tools = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const tool = normalizedTool(
      entry?.tool || entry?.name,
      parsedArguments(entry?.args ?? entry?.arguments),
      entry?.id,
      requestId,
      index,
    );
    if (tool) tools.push(tool);
  }
  return tools.length ? tools : null;
}

function jsonLooksLikeToolCall(parsed) {
  if (Array.isArray(parsed)) {
    return parsed.some(entry => entry && typeof entry === "object" && !Array.isArray(entry)
      && (entry.tool || entry.name || entry.function));
  }
  return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed) && (
    parsed.tool || parsed.name || parsed.tool_calls || parsed.function_calls || parsed.function
  ));
}

function toolText(tools) {
  if (!tools || !tools.length) return INVALID_TOOL_CALL;
  return JSON.stringify(tools.length === 1 ? tools[0] : tools);
}

export function normalizeLlmProxyText(text, requestId = "") {
  const trimmed = String(text || "").trim();
  const source = stripReasoningTags(trimmed);
  let parsed = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    try {
      parsed = JSON.parse(source);
    } catch {
      parsed = null;
    }
  }
  if (parsed && (Array.isArray(parsed) || (typeof parsed === "object" && !Array.isArray(parsed)))) {
    const json = parsedJsonCalls(parsed, requestId);
    if (json) return { kind: "tool", text: toolText(json), tool: json[0], tools: json };
    if (jsonLooksLikeToolCall(parsed)) return { kind: "invalid", text: INVALID_TOOL_CALL, tool: null, tools: [] };
  }
  if (!source) return { kind: "prose", text: source, tool: null, tools: [] };
  if (/^<(?:functions|tools)\b[\s\S]*?<\/(?:functions|tools)>\s*$/i.test(source)) {
    const tools = /^<tools\b/i.test(source)
      ? parsedToolsXml(source, requestId)
      : parsedFunctionsXml(source, requestId);
    if (tools && tools.length) return { kind: "tool", text: toolText(tools), tool: tools[0], tools };
    return { kind: "invalid", text: INVALID_TOOL_CALL, tool: null, tools: [] };
  }
  if (/^<(?:functions?|tools?)\b/i.test(source)) {
    return { kind: "invalid", text: INVALID_TOOL_CALL, tool: null, tools: [] };
  }
  return { kind: "prose", text: source, tool: null, tools: [] };
}

function normalizedCallMessage(call, requestId, index = 0) {
  const tool = normalizedTool(
    call?.function?.name || call?.name,
    parsedArguments(call?.function?.arguments ?? call?.arguments),
    call?.id,
    requestId,
    index,
  );
  return canonicalCallMessage(tool);
}

function canonicalCallMessage(tool) {
  if (!tool) return null;
  return {
    id: tool.id,
    type: "function",
    function: { name: tool.tool, arguments: JSON.stringify(tool.args) },
  };
}

export function normalizeLlmProxyMessage(message, requestId = "") {
  const calls = Array.isArray(message?.tool_calls)
    ? message.tool_calls
    : message?.function_call
      ? [{ function: message.function_call }]
      : null;
  if (calls) {
    const normalized = calls
      .map((call, index) => normalizedCallMessage(call, requestId, index))
      .filter(Boolean);
    if (!normalized.length) return { role: "assistant", content: INVALID_TOOL_CALL };
    const content = stripReasoningTags(message.content) || null;
    return { role: "assistant", content, tool_calls: normalized };
  }
  const result = normalizeLlmProxyText(message?.content || "", requestId);
  if (result.kind !== "tool") return { role: "assistant", content: result.text };
  return {
    role: "assistant",
    content: null,
    tool_calls: result.tools.map(tool => canonicalCallMessage(tool)),
  };
}

export function canonicalLlmProxyToolText(calls) {
  const tools = (Array.isArray(calls) ? calls : []).map(call => normalizedTool(
    call?.function?.name || call?.name,
    parsedArguments(call?.function?.arguments ?? call?.arguments),
    call?.id,
    "",
  )).filter(Boolean);
  return toolText(tools);
}

export function normalizeLlmProxyChunk(chunk, requestId = "") {
  if (!chunk?.choices) return chunk;
  return {
    ...chunk,
    choices: chunk.choices.map(choice => {
      const delta = choice.delta || choice.message;
      if (!delta?.function_call || delta.tool_calls) return choice;
      return {
        ...choice,
        [choice.delta ? "delta" : "message"]: {
          ...delta,
          tool_calls: [{
            index: 0,
            id: stableCallId(requestId, 0),
            type: "function",
            function: delta.function_call,
          }],
          function_call: undefined,
        },
      };
    }),
  };
}

export async function parseLlmProxyStream(response, callbacks, options, parseBase) {
  let invalidNativeCall = false;
  const result = await parseBase(response, {
    ...callbacks,
    ...options,
    onToken: undefined,
    normalizeChunk: chunk => normalizeLlmProxyChunk(chunk, options?.requestId),
    onEvent: event => {
      if (["first-byte", "usage"].includes(event?.type)) callbacks?.onEvent?.(event);
      if (event?.type === "error") invalidNativeCall = true;
    },
  });
  const normalized = invalidNativeCall
    ? { kind: "invalid", text: INVALID_TOOL_CALL, tool: null, tools: [] }
    : normalizeLlmProxyText(result.text, options?.requestId);
  if (normalized.kind === "tool") {
    callbacks?.onEvent?.({
      type: "tool-call-delta",
      delta: normalized.tools.map((tool, index) => ({
        index,
        id: tool.id,
        type: "function",
        function: { name: tool.tool, arguments: JSON.stringify(tool.args) },
      })),
    });
    callbacks?.onEvent?.({ type: "finish", reason: "tool-calls" });
    return { text: normalized.text, reason: "tool-calls" };
  }
  if (normalized.kind === "invalid") {
    callbacks?.onEvent?.({ type: "text-delta", text: normalized.text });
    callbacks?.onEvent?.({ type: "finish", reason: "stop" });
    return { text: normalized.text, reason: "stop" };
  }
  if (normalized.text) callbacks?.onEvent?.({ type: "text-delta", text: normalized.text });
  callbacks?.onEvent?.({ type: "finish", reason: "stop" });
  return { text: normalized.text, reason: "stop" };
}

export function promptToolMessages(messages, tools) {
  if (!tools.length) return messages;
  const instruction = [
    "Use only the tools listed below when repository inspection or execution is required.",
    "Tool names are case-sensitive. Never invent a tool name or return an executable command as prose.",
    "To call a tool, respond with exactly one JSON object and no Markdown or explanation:",
    '{"tool":"<name>","args":{...},"id":"<unique-id>"}',
    "After receiving a tool result, continue the original task and call another tool only when needed.",
    `Available tools: ${JSON.stringify(tools.map(publicTool))}`,
  ].join("\n");
  return [{ role: "system", content: instruction }, ...messages.map(convertedMessage)];
}
