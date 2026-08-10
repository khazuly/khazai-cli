import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

function stableMessageId(message, index) {
  if (message?.id) return String(message.id);
  const digest = createHash("sha256")
    .update(String(message?.role || message?.type || "message"))
    .update("\0")
    .update(String(message?.content || ""))
    .update("\0")
    .update(String(index))
    .digest("hex")
    .slice(0, 16);
  return `message_${digest}`;
}

export function hydrateCanonicalMessages(messages, { limit = Infinity } = {}) {
  const startedAt = performance.now();
  const measurePairing = Boolean(process.env.KHAZAI_DEBUG_PERF);
  let pairingMs = 0;
  const source = Array.isArray(messages) ? messages : [];
  const start = Math.max(0, source.length - Math.max(0, Number(limit) || 0));
  const hydrated = [];
  const messageById = new Map();
  const toolCallById = new Map();
  const toolResultByCallId = new Map();
  const usageByRequestId = new Map();
  for (let index = start; index < source.length; index++) {
    const raw = source[index];
    if (!raw || typeof raw !== "object") continue;
    if (String(raw.content || "").startsWith("[INTERNAL STEERING]")) continue;
    const id = stableMessageId(raw, index);
    const message = raw.id === id ? raw : { ...raw, id };
    hydrated.push(message);
    messageById.set(id, message);
    const pairingStartedAt = measurePairing ? performance.now() : 0;
    for (const call of message.tool_calls || []) {
      if (call?.id) toolCallById.set(String(call.id), { message, call });
    }
    if (message.role === "tool" && message.tool_call_id) {
      toolResultByCallId.set(String(message.tool_call_id), message);
    }
    if (message.requestId && message.usage) usageByRequestId.set(String(message.requestId), message.usage);
    if (measurePairing) pairingMs += performance.now() - pairingStartedAt;
  }
  const hydrationMs = performance.now() - startedAt;
  return {
    messages: hydrated,
    indexes: { messageById, toolCallById, toolResultByCallId, usageByRequestId },
    hydrationMs,
    timings: {
      canonicalMessageHydrationMs: Math.max(0, hydrationMs - pairingMs),
      toolCallResultPairingMs: pairingMs,
    },
  };
}
