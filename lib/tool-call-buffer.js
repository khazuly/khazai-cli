function completeJson(value) {
  try {
    JSON.parse(String(value || ""));
    return true;
  } catch {
    return false;
  }
}

function mergedName(current, incoming) {
  const next = String(incoming || "");
  if (!next) return current;
  return next.startsWith(current) ? next : `${current}${next}`;
}

function scoped(scope, call) {
  return {
    requestId: String(scope.requestId || ""),
    runId: String(scope.runId || ""),
    turnId: String(scope.turnId || ""),
    taskEpoch: Number(scope.taskEpoch) || 0,
    toolCallId: String(call.id || ""),
    providerStreamIndex: Number(call.index) || 0,
    toolNameComplete: Boolean(call.name),
    argumentsComplete: completeJson(call.arguments),
    finishReason: String(scope.finishReason || ""),
  };
}

export function createToolCallBuffer(scope = {}) {
  const calls = new Map();
  let finishReason = "";
  let reportedPartial = null;

  const ensure = index => {
    const key = Number(index) || 0;
    const current = calls.get(key) || { index: key, id: "", name: "", arguments: "" };
    calls.set(key, current);
    return current;
  };

  return {
    accept(delta = []) {
      for (const entry of delta) {
        const current = ensure(entry?.index);
        if (entry?.id) current.id = String(entry.id);
        current.name = mergedName(current.name, entry?.function?.name);
        current.arguments += String(entry?.function?.arguments || "");
      }
    },
    acceptPartial(partial) {
      if (!partial || typeof partial !== "object") return;
      const current = ensure(partial.providerStreamIndex);
      current.id = String(partial.toolCallId || current.id);
      current.name = String(partial.toolName || current.name);
      reportedPartial = { ...scoped(scope, current), ...partial };
    },
    finish(reason = "") {
      finishReason = String(reason || "");
    },
    incomplete() {
      if (reportedPartial) return { ...reportedPartial, finishReason: reportedPartial.finishReason || finishReason };
      for (const call of calls.values()) {
        const diagnostic = scoped({ ...scope, finishReason }, call);
        if (!diagnostic.toolNameComplete || !diagnostic.argumentsComplete) return diagnostic;
      }
      return null;
    },
  };
}

export function syntheticPartialToolCall(text, scope = {}) {
  const source = String(text || "").trim();
  if (!/"tool"\s*:/i.test(source) || completeJson(source)) return null;
  const name = /"tool"\s*:\s*"([^"\\]*)"/.exec(source);
  const id = /"(?:id|tool_call_id)"\s*:\s*"([^"\\]*)"/.exec(source);
  const argsAt = source.search(/"(?:args|arguments)"\s*:/i);
  const call = {
    index: 0,
    id: id?.[1] || "",
    name: name?.[1] || "",
    arguments: argsAt < 0 ? "" : source.slice(argsAt),
  };
  return scoped(scope, call);
}
