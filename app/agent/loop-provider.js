import { randomUUID } from "node:crypto";
import { createAssistantTextGuard, sanitizeAssistantIdentity } from "../../lib/assistant-text.js";
import { createPublicActivityChannel } from "../public-activity.js";
import { streamDisposition } from "./helpers/task.js";
import { LEGACY_PROTOCOL_HOLDBACK } from "./helpers/parser.js";
import { emitRequestMetrics } from "../performance-timings.js";

export async function* requestProviderTurn({ ctx, nativeTools, requestModel, controller, run, pendingProse, maxAttempts, isRunActive, isRunCurrent, scoped, runId, turnId, taskEpoch, retryProvider, phase, projected }) {
let reply;
let streamMode = "pending", streamTail = "";
let streamStarted = false;
let streamVisibleLength = 0;
let finalError = null;
let nativeToolStream = false;
let typedProviderStream = false;
const deferProse = Boolean(pendingProse);
for (let attempt = 0; attempt < maxAttempts; attempt++) {
  const providerRequestId = randomUUID();
  let chatErr;
  let receivedAnyToken = false;
  const publicActivity = createPublicActivityChannel(run, value => this.redactSerializableForDisplay(value));
  const eventQueue = [];
  let eventResolve = null;
  const queueEvent = event => {
    if (!event || !isRunActive()) return;
    if (eventResolve) {
      const resolveEvent = eventResolve;
      eventResolve = null;
      resolveEvent(event);
    } else {
      eventQueue.push(event);
    }
  };
  const compatibilityGuard = createAssistantTextGuard();
  const onToken = token => {
    if (!isRunActive()) return;
    this._markLatency("providerFirstDelta");
    receivedAnyToken = true;
    const text = compatibilityGuard.push(token);
    if (text) queueEvent({ type: "text-delta", text, compatibility: true });
  };
  const onEvent = event => {
    if (!isRunActive()) return;
    if (event?.type === "first-byte") {
      this._markLatency("providerFirstByte");
      return;
    }
    if (event?.type === "usage") {
      this._usageTracker.record({ ...event, requestId: providerRequestId }, run);
      const reportedLimit = Number(event.contextLimit);
      if (Number.isFinite(reportedLimit) && reportedLimit > 0) {
        this._providerContextLimit = reportedLimit;
      }
      return;
    }
    if (event?.type === "request-prepared") {
      Object.assign(this._latency, event.timings || {});
      if (this._latency.requestBytes !== undefined) {
        emitRequestMetrics("request-serialization", {
          requestBytes: this._latency.requestBytes,
          serializationMs: this._latency.serializationMs ?? null,
        });
      }
      return;
    }
    if (event?.type === "provider-fallback") {
      queueEvent(event);
      return;
    }
    typedProviderStream = true;
    if (["text-delta", "reasoning-delta", "tool-call-delta"].includes(event?.type)) {
      this._markLatency("providerFirstDelta");
      receivedAnyToken = true;
    }
    if (event?.type === "text-delta" && event.text) queueEvent(event);
    if (event?.type === "reasoning-delta" && event.text) queueEvent(event);
    if (event?.type === "tool-call-delta") nativeToolStream = true;
    for (const activity of publicActivity.accept(event)) queueEvent(activity);
  };
  if (!isRunActive()) return;
  yield scoped({ type: "phase", label: "Uploading model request" });
  this._markLatency("requestDispatched");
  let temperature, topP, maxTokens;
  try {
    const mod = await import("../../config/model-settings.js");
    const settings = mod.resolveEffectiveSettings(requestModel);
    temperature = settings.temperature;
    topP = settings.topP;
    maxTokens = settings.maxOutputTokens;
    const caps = mod.resolveProviderCapabilities(requestModel);
    if (!caps.supportsTemperature) temperature = undefined;
    if (!caps.supportsTopP) topP = undefined;
    if (!caps.supportsMaxTokens) maxTokens = undefined;
  } catch {}
  const chatDone = this._chat(ctx, {
    model: requestModel, onToken, onEvent,
    signal: controller.signal,
    timeoutMs: this._config.providerTimeout,
    reasoningEffort: this._config.reasoningEffort,
    temperature,
    topP,
    maxTokens,
    tools: nativeTools, sessionId: this._sessionId, runId, turnId, taskEpoch,
    requestId: providerRequestId,
    isActive: () => isRunActive(),
    bypassProviderHealth: retryProvider,
    streamPhase: phase,
    projectedTokens: Number.isFinite(Number(projected?.tokens)) ? projected.tokens : undefined,
  })
    .then(result => {
      if (!isRunActive()) return;
      if (typedProviderStream) {
        reply = sanitizeAssistantIdentity(result);
        return;
      }
      const completed = compatibilityGuard.finish(result);
      if (completed.output) {
        queueEvent({ type: "text-delta", text: completed.output, compatibility: true });
      }
      reply = completed.text;
    })
    .catch(error => {
      if (isRunCurrent()) chatErr = error;
    });
  const waitForEvent = () => new Promise(resolveEvent => { eventResolve = resolveEvent; });
  yield scoped({ type: "phase", label: "Waiting for model response" });
  while (reply === undefined && chatErr === undefined) {
    const event = eventQueue.length > 0
      ? eventQueue.shift()
      : await Promise.race([waitForEvent(), chatDone.then(() => undefined)]);
    if (!isRunActive()) return;
    if (event === undefined) continue;
    if (event.type === "provider-fallback") {
      yield scoped({
        type: "answer",
        content: `${requestModel} is unavailable. Continuing with ${event.model}.`,
      });
      continue;
    }
    if (event.type === "reasoning-delta") continue;
    if (event.type === "public-activity") { yield scoped(event); continue; }
    const token = event.text;
    if (typedProviderStream && !event.compatibility) {
      streamMode = "text";
      streamStarted = true;
      streamVisibleLength += token.length;
      this._markLatency("uiFirstText");
      yield scoped({ type: "stream", token });
      continue;
    }
    streamTail += token;
    const disposition = streamDisposition(streamTail);
    if (disposition === "structured" || streamMode === "pending") streamMode = disposition;
    if (streamMode === "text" && !deferProse && streamTail.length > LEGACY_PROTOCOL_HOLDBACK) {
      const visible = streamTail.slice(0, -LEGACY_PROTOCOL_HOLDBACK);
      streamTail = streamTail.slice(-LEGACY_PROTOCOL_HOLDBACK);
      streamStarted = true;
      streamVisibleLength += visible.length;
      this._markLatency("uiFirstText");
      yield scoped({ type: "stream", token: visible });
    }
  }
  while (eventQueue.length > 0) {
    const event = eventQueue.shift();
    if (event.type === "reasoning-delta") continue;
    if (event.type === "public-activity") { yield scoped(event); continue; }
    const token = event.text;
    if (typedProviderStream && !event.compatibility) {
      streamMode = "text";
      streamStarted = true;
      streamVisibleLength += token.length;
      this._markLatency("uiFirstText");
      yield scoped({ type: "stream", token });
      continue;
    }
    streamTail += token;
    const disposition = streamDisposition(streamTail);
    if (disposition === "structured" || streamMode === "pending") streamMode = disposition;
    if (streamMode === "text" && !deferProse && streamTail.length > LEGACY_PROTOCOL_HOLDBACK) {
      const visible = streamTail.slice(0, -LEGACY_PROTOCOL_HOLDBACK);
      streamTail = streamTail.slice(-LEGACY_PROTOCOL_HOLDBACK);
      streamStarted = true;
      streamVisibleLength += visible.length;
      this._markLatency("uiFirstText");
      yield scoped({ type: "stream", token: visible });
    }
  }
  await chatDone.catch(() => {});
  if (!isRunActive()) return;
  if (!chatErr) break;
  finalError = chatErr;
  if (streamStarted || receivedAnyToken || /request timed out|timeout|timed out/i.test(String(chatErr?.message || chatErr))) break;
  if (attempt < maxAttempts - 1) {
    if (!isRunActive()) break;
    try {
      if (this._resetSession) await this._resetSession({ signal: controller.signal });
      if (!isRunActive()) break;
      reply = undefined;
      streamTail = "";
      streamMode = "pending";
      streamVisibleLength = 0;
      continue;
    } catch (resetError) {
      finalError = resetError;
    }
  }
  break;
}
  return { reply, streamMode, streamTail, streamStarted, streamVisibleLength, finalError, nativeToolStream, typedProviderStream };
}
