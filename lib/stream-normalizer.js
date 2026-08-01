
function toolJsonComplete(argumentsText) {
  const source = String(argumentsText || "");
  if (!source.trim()) return false;
  try {
    JSON.parse(source);
    return true;
  } catch {
    return false;
  }
}

export function createStreamNormalizer({ requestId = "", runId = "" } = {}) {
  let finished = false;
  let failed = false;
  let usageEmitted = false;
  let finishReason = null;
  const calls = new Map();

  const emit = (type, data) => ({ type, requestId, runId, data });

  function handleChunk(chunk = {}) {
    if (finished) return [];
    const events = [];
    if (chunk.usage && !usageEmitted) {
      usageEmitted = true;
      events.push(emit("usage", {
        inputTokens: chunk.usage.prompt_tokens ?? chunk.usage.input_tokens,
        outputTokens: chunk.usage.completion_tokens ?? chunk.usage.output_tokens,
        model: chunk.model || null,
        contextLimit: chunk.context_limit ?? chunk.context_window ?? null,
      }));
    }
    const choice = chunk.choices?.[0] || {};
    const delta = choice.delta || choice.message || {};
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === "string" && reasoning) {
      events.push(emit("reasoning_delta", { text: reasoning }));
    }
    const content = delta.content;
    if (typeof content === "string" && content) {
      events.push(emit("text_delta", { text: content }));
    }
    for (const entry of delta.tool_calls || []) {
      const index = Number(entry.index ?? 0);
      let call = calls.get(index);
      if (!call) {
        call = { id: "", name: "", arguments: "" };
        calls.set(index, call);
        events.push(emit("tool_call_start", {
          index,
          id: entry.id || "",
          name: entry.function?.name || "",
        }));
      }
      if (entry.id) call.id = entry.id;
      if (entry.type) call.type = entry.type;
      if (entry.function?.name) call.name += entry.function.name;
      if (entry.function?.arguments) call.arguments += entry.function.arguments;
      events.push(emit("tool_call_delta", {
        index,
        id: call.id,
        name: call.name,
        arguments: entry.function?.arguments || "",
      }));
    }
    return events;
  }

  function complete({ reason = "stop", output = "" } = {}) {
    if (finished) return [];
    finished = true;
    finishReason = reason;
    const events = [];
    const callsList = [...calls.entries()].sort((left, right) => left[0] - right[0]);
    for (const [index, call] of callsList) {
      const valid = toolJsonComplete(call.arguments);
      events.push(emit("tool_call_end", {
        index,
        id: call.id,
        name: call.name,
        arguments: call.arguments,
        valid,
      }));
      if (!valid) {
        const error = new Error("Provider returned an incomplete tool-call payload.");
        error.code = "INVALID_TOOL_JSON";
        error.failureClass = "malformed_payload";
        error.streamPhase = "tool-call";
        events.push(emit("error", { message: error.message, code: error.code, error }));
      }
    }
    events.push(emit("finish", { reason, output }));
    return events;
  }

  function fail(error) {
    if (finished) return [];
    finished = true;
    failed = true;
    return [emit("error", {
      message: String(error?.message || error || "Provider stream failed"),
      code: error?.code || "",
      error,
    })];
  }

  function toolCalls() {
    return [...calls.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([index, call]) => ({ index, ...call }))
      .filter(call => call.name);
  }

  function hasToolCalls() {
    return calls.size > 0;
  }

  return {
    handleChunk,
    complete,
    fail,
    toolCalls,
    hasToolCalls,
    get finished() { return finished; },
    get failed() { return failed; },
    get finishReason() { return finishReason; },
  };
}

export function canonicalToolText(calls) {
  const normalized = calls.flatMap(call => {
    if (!call?.name) return [];
    let args = {};
    try { args = JSON.parse(call.arguments || "{}"); } catch { return []; }
    return [{ tool: call.name, args, id: call.id || undefined }];
  });
  if (normalized.length === 0) return "";
  return JSON.stringify(normalized.length === 1 ? normalized[0] : normalized);
}

export function translateLegacyEvent(event) {
  if (!event) return null;
  switch (event.type) {
    case "text_delta":
      return { type: "text-delta", text: event.data.text };
    case "reasoning_delta":
      return { type: "reasoning-delta", text: event.data.text };
    case "tool_call_start":
    case "tool_call_delta":
      return {
        type: "tool-call-delta",
        delta: [{
          index: event.data.index,
          id: event.data.id,
          type: "function",
          function: { name: event.data.name, arguments: event.data.arguments },
        }],
      };
    case "usage":
      return { type: "usage", ...event.data };
    case "finish":
      return { type: "finish", reason: event.data.reason };
    case "error":
      return { type: "error", error: event.data.error };
    default:
      return null;
  }
}
