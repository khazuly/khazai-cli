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
  ["grep", "grep"],
  ["glob", "glob"],
]);

const INVALID_TOOL_CALL = "[×] Invalid llmproxy tool call.";

function stableCallId(requestId) {
  const suffix = String(requestId || "call").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return `llmproxy_${suffix || "call"}`;
}

function normalizedTool(name, args, id, requestId) {
  const requested = String(name || "").trim();
  if (!requested || !args || typeof args !== "object" || Array.isArray(args)) return null;
  const canonical = SAFE_TOOL_ALIASES.get(requested.toLowerCase()) || requested;
  return { tool: canonical, args, id: String(id || stableCallId(requestId)) };
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

function parsedXmlCall(text, requestId) {
  const source = String(text || "").trim();
  const candidate = /^<functions>\s*<function>\s*<name>\s*([^<>]+?)\s*<\/name>\s*<args>\s*([\s\S]*?)\s*<\/args>\s*<\/function>\s*<\/functions>$/i.exec(source);
  if (!candidate) return null;
  return normalizedTool(candidate[1], parsedArguments(candidate[2]), null, requestId);
}

function parsedJsonCall(text, requestId) {
  try {
    const parsed = JSON.parse(String(text || "").trim());
    if (Array.isArray(parsed)) {
      if (parsed.length !== 1) return null;
      return normalizedTool(parsed[0]?.tool || parsed[0]?.name, parsedArguments(parsed[0]?.args ?? parsed[0]?.arguments), parsed[0]?.id, requestId);
    }
    return normalizedTool(parsed?.tool || parsed?.name, parsedArguments(parsed?.args ?? parsed?.arguments), parsed?.id, requestId);
  } catch {
    return null;
  }
}

export function normalizeLlmProxyText(text, requestId = "") {
  const source = String(text || "").trim();
  const xmlCandidate = /^<functions(?:>|\s)/i.test(source) || /<\/functions>$/i.test(source);
  const tool = xmlCandidate ? parsedXmlCall(source, requestId) : parsedJsonCall(source, requestId);
  if (tool) return { kind: "tool", text: JSON.stringify(tool), tool };
  if (xmlCandidate) return { kind: "invalid", text: INVALID_TOOL_CALL, tool: null };
  return { kind: "prose", text: source, tool: null };
}

function normalizedCallMessage(call, requestId) {
  const tool = normalizedTool(
    call?.function?.name || call?.name,
    parsedArguments(call?.function?.arguments ?? call?.arguments),
    call?.id,
    requestId,
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
    const normalized = calls.length === 1 ? normalizedCallMessage(calls[0], requestId) : null;
    return normalized
      ? { role: "assistant", content: message.content || null, tool_calls: [normalized] }
      : { role: "assistant", content: INVALID_TOOL_CALL };
  }
  const result = normalizeLlmProxyText(message?.content || "", requestId);
  if (result.kind !== "tool") return { role: "assistant", content: result.text };
  return {
    role: "assistant",
    content: null,
    tool_calls: [canonicalCallMessage(result.tool)],
  };
}

export function canonicalLlmProxyToolText(calls) {
  const tools = calls.map(call => normalizedTool(
    call?.function?.name || call?.name,
    parsedArguments(call?.function?.arguments ?? call?.arguments),
    call?.id,
    "",
  )).filter(Boolean);
  if (tools.length !== 1) return INVALID_TOOL_CALL;
  return JSON.stringify(tools[0]);
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
            id: stableCallId(requestId),
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
    ? { kind: "invalid", text: INVALID_TOOL_CALL }
    : normalizeLlmProxyText(result.text, options?.requestId);
  if (normalized.kind === "tool") {
    callbacks?.onEvent?.({
      type: "tool-call-delta",
      delta: [{
        index: 0,
        id: normalized.tool.id,
        type: "function",
        function: { name: normalized.tool.tool, arguments: JSON.stringify(normalized.tool.args) },
      }],
    });
    callbacks?.onEvent?.({ type: "finish", reason: "tool-calls" });
    return { text: normalized.text, reason: "tool-calls" };
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
