import { createOpenAICompatibleAdapter, normalizeMessages } from "./provider-adapter.js";
import { sanitizeAssistantIdentity } from "./assistant-text.js";
import { performance } from "node:perf_hooks";

export function mergeToolCallDelta(calls, delta = {}) {
  for (const entry of delta.tool_calls || []) {
    const index = Number(entry.index || 0);
    const current = calls.get(index) || {
      id: "",
      type: "function",
      function: { name: "", arguments: "" },
    };
    if (entry.id) current.id = entry.id;
    if (entry.type) current.type = entry.type;
    if (entry.function?.name) current.function.name += entry.function.name;
    if (entry.function?.arguments) current.function.arguments += entry.function.arguments;
    calls.set(index, current);
  }
}


export function toProviderMessages(messages) {
  return normalizeMessages(messages);
}

function retryAfterMs(response) {
  const value = response.headers?.get?.("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function affinityToken(value, attempt) {
  let hash = 2166136261;
  for (const character of `${value}:${attempt}`) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(-4);
}

export class OpenAICompatibleProvider {
  constructor({ id, baseURL, apiKey = "", headers = {}, rotateSessionAffinity = false, compatibility = {} }) {
    this.id = id;
    this.baseURL = String(baseURL || "").replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.headers = headers;
    this.rotateSessionAffinity = rotateSessionAffinity;
    this.adapter = createOpenAICompatibleAdapter({ id, baseURL: this.baseURL, compatibility });
  }

  retryOptions(options, attempt) {
    const session = options.headers?.["x-opencode-session"];
    if (!this.rotateSessionAffinity || attempt === 0 || !session) return options;
    return {
      ...options,
      headers: {
        ...options.headers,
        "x-opencode-session": `${session}-${affinityToken(session, attempt)}`,
      },
    };
  }

  chatURL() {
    return /\/chat\/completions$/i.test(this.baseURL)
      || /\.[a-z0-9]{2,8}$/i.test(this.baseURL)
      ? this.baseURL
      : `${this.baseURL}/chat/completions`;
  }

  modelsURL() {
    return this.chatURL().replace(/\/chat\/completions$/i, "/models");
  }

  requestHeaders(headers = {}) {
    return {
      "Content-Type": "application/json",
      ...(this.apiKey ? { "Authorization": `Bearer ${this.apiKey}` } : {}),
      ...this.headers,
      ...headers,
    };
  }

  async listModels({ signal } = {}) {
    const response = await fetch(this.modelsURL(), {
      headers: this.requestHeaders(),
      signal,
    });
    if (!response.ok) throw new Error(`Model discovery failed with HTTP ${response.status}.`);
    const data = await response.json();
    return (data.data || data.models || [])
      .map(entry => typeof entry === "string" ? entry : entry.id)
      .filter(Boolean)
      .sort();
  }

  async chat(messages, {
    model,
    signal,
    timeoutMs = 300_000,
    onToken,
    onEvent,
    tools = [],
    headers = {},
    includeUsage = false,
    maxTokens,
    toolChoice = "auto",
    temperature,
    topP,
    parallelToolCalls,
    capabilities = {},
    requestId = "",
  } = {}) {
    const controller = new AbortController();
    const abortParent = () => controller.abort(signal?.reason);
    if (signal?.aborted) abortParent();
    else signal?.addEventListener("abort", abortParent, { once: true });
    const requestTimeout = Math.max(1_000, Number(timeoutMs) || 300_000);
    const timer = setTimeout(() => controller.abort(new Error("Request timed out")), requestTimeout);
    const endpoint = this.chatURL();
    let messageCount = Array.isArray(messages) ? messages.length : 0;
    let toolCount = Array.isArray(tools) ? tools.length : 0;
    let payloadFields = [];

    try {
      const adapter = this.adapter;
      const preparationStartedAt = performance.now();
      const providerMessages = adapter.normalizeMessages(messages, capabilities);
      const messagesPreparedAt = performance.now();
      const requestTools = adapter.normalizeTools(tools, capabilities);
      const body = adapter.buildRequest({
        model,
        messages: providerMessages,
        tools: requestTools,
        options: {
          includeUsage,
          maxTokens,
          toolChoice,
          temperature,
          topP,
          parallelToolCalls,
        },
        capabilities,
      });
      onEvent?.({ type: "request-prepared", timings: { providerMessageConversionMs: messagesPreparedAt - preparationStartedAt, providerRequestPreparationMs: performance.now() - preparationStartedAt } });
      messageCount = providerMessages.length;
      toolCount = requestTools.length;
      payloadFields = Object.keys(body);
      const response = await fetch(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: this.requestHeaders(headers),
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        const error = new Error(`HTTP ${response.status}: ${response.statusText || "Provider request failed"}`);
        error.status = response.status;
        error.retryAfterMs = retryAfterMs(response);
        error.requestId = response.headers?.get?.("x-request-id")
          || response.headers?.get?.("request-id")
          || "";
        error.providerDetail = detail.slice(0, 1_000);
        error.streamPhase = "response";
        error.endpoint = endpoint;
        error.messageCount = providerMessages.length;
        error.toolCount = requestTools.length;
        error.streaming = body.stream;
        error.payloadFields = payloadFields;
        throw error;
      }

      const contentType = response.headers?.get?.("content-type") || "";
      if (body.stream && response.body && /text\/event-stream/i.test(contentType)) {
        const result = await adapter.parseStream(response, {
          onEvent,
          onToken,
          model,
          requestId,
          includeUsage,
        });
        return result.text;
      }

      const data = await response.json();
      if (data.usage) {
        const usage = adapter.normalizeUsage(data.usage, model);
        onEvent?.({ type: "usage", ...usage });
      }
      const rawMessage = data.choices?.[0]?.message
        || (typeof data.content === "string" ? { content: data.content } : {});
      const message = adapter.normalizeResponseMessage(rawMessage, { requestId, model });
      if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
        const calls = new Map();
        for (const [index, call] of message.tool_calls.entries()) {
          calls.set(index, {
            id: call.id,
            type: "function",
            function: { name: call.function?.name, arguments: call.function?.arguments || "{}" },
          });
        }
        const { canonicalToolText } = adapter;
        onEvent?.({ type: "finish", reason: "tool-calls" });
        return canonicalToolText([...calls.values()]);
      }
      const result = sanitizeAssistantIdentity(stripThinking(message.content || "")).trim();
      if (result) {
        if (onEvent) onEvent({ type: "text-delta", text: result });
        else onToken?.(result);
      }
      onEvent?.({ type: "finish", reason: "stop" });
      return result;
    } catch (error) {
      error.endpoint ||= endpoint;
      error.messageCount ??= messageCount;
      error.toolCount ??= toolCount;
      error.streaming ??= capabilities.supportsStreaming !== false;
      error.payloadFields ||= payloadFields;
      onEvent?.({ type: "error", error });
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortParent);
    }
  }
}


function stripThinking(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, "")
    .replace(/<think>[\s\S]*$/gi, "");
}
