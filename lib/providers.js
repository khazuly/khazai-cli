import { createAssistantTextGuard, sanitizeAssistantIdentity } from "./assistant-text.js";
import { randomUUID } from "node:crypto";

function stripThinking(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, "")
    .replace(/<think>[\s\S]*$/gi, "");
}

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

function parseSseEvent(event) {
  const payload = event
    .split("\n")
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trimStart())
    .join("\n");
  if (!payload || payload === "[DONE]") return { done: payload === "[DONE]", data: null };
  try {
    return { done: false, data: JSON.parse(payload) };
  } catch {
    return { done: false, data: null };
  }
}

async function readSse(body, onEvent) {
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const event = parseSseEvent(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      if (event.data) {
        onEvent(event.data);
        if (event.data.choices?.some?.(choice => choice.finish_reason)) completed = true;
      }
      if (event.done) {
        completed = true;
        break;
      }
    }
    if (completed) break;
  }
  buffer += decoder.decode();
  if (!completed && buffer.trim()) {
    const event = parseSseEvent(buffer.replace(/\r\n/g, "\n"));
    if (event.data) {
      onEvent(event.data);
      if (event.data.choices?.some?.(choice => choice.finish_reason)) completed = true;
    }
    if (event.done) completed = true;
  }
  if (!completed) {
    const error = new Error("Provider stream ended before completion.");
    error.code = "PREMATURE_STREAM";
    error.streamPhase = "stream";
    throw error;
  }
}

function canonicalToolText(toolCalls) {
  const normalized = [...toolCalls.values()].flatMap(call => {
    if (!call?.function?.name) return [];
    let args = {};
    try { args = JSON.parse(call.function.arguments || "{}"); } catch {}
    return [{ tool: call.function.name, args, id: call.id || undefined }];
  });
  if (normalized.length === 0) return "";
  return JSON.stringify(normalized.length === 1 ? normalized[0] : normalized);
}

function parsedSyntheticCalls(content) {
  try {
    const parsed = JSON.parse(String(content || ""));
    const list = Array.isArray(parsed) ? parsed : [parsed];
    if (!list.length || !list.every(item => item && typeof item.tool === "string" && item.args && typeof item.args === "object")) {
      return null;
    }
    return list.map(item => {
      const args = Object.fromEntries(Object.entries(item.args).filter(([key]) => !key.startsWith("_")));
      return {
        id: String(item.id || `call_${randomUUID()}`),
        type: "function",
        function: { name: item.tool, arguments: JSON.stringify(args) },
      };
    });
  } catch {
    return null;
  }
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

export function toProviderMessages(messages) {
  const output = [];
  let calls = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const parsed = message.role === "assistant" ? parsedSyntheticCalls(message.content) : null;
    if (parsed) {
      let results = 0;
      for (let lookahead = index + 1; lookahead < messages.length; lookahead++) {
        const candidate = messages[lookahead];
        if (candidate.role === "assistant") break;
        if (candidate.role === "user" && /^---TOOL (?:RESULT|ERROR):\s*.+?---/i.test(String(candidate.content || ""))) {
          results++;
        }
      }
      if (results >= parsed.length) {
        calls = [...parsed];
        output.push({ role: "assistant", content: null, tool_calls: parsed });
        continue;
      }
    }
    const result = message.role === "user"
      ? /^---TOOL (RESULT|ERROR):\s*(.+?)---\n?([\s\S]*)$/i.exec(String(message.content || ""))
      : null;
    if (result && calls.length) {
      const call = calls.shift();
      output.push({
        role: "tool",
        tool_call_id: call.id,
        name: result[2].trim(),
        content: result[3],
      });
      continue;
    }
    output.push(message);
  }
  return output;
}

export class OpenAICompatibleProvider {
  constructor({ id, baseURL, apiKey = "", headers = {}, rotateSessionAffinity = false }) {
    this.id = id;
    this.baseURL = String(baseURL || "").replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.headers = headers;
    this.rotateSessionAffinity = rotateSessionAffinity;
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
  } = {}) {
    const controller = new AbortController();
    const abortParent = () => controller.abort(signal?.reason);
    if (signal?.aborted) abortParent();
    else signal?.addEventListener("abort", abortParent, { once: true });
    const requestTimeout = Math.max(1_000, Number(timeoutMs) || 300_000);
    const timer = setTimeout(() => controller.abort(new Error("Request timed out")), requestTimeout);

    try {
      const response = await fetch(this.chatURL(), {
        method: "POST",
        signal: controller.signal,
        headers: this.requestHeaders(headers),
        body: JSON.stringify({
          model,
          messages: toProviderMessages(messages),
          stream: true,
          ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
          ...(Number.isFinite(maxTokens) ? { max_tokens: maxTokens } : {}),
          ...(tools.length ? {
            tools,
            ...(toolChoice ? { tool_choice: toolChoice } : {}),
          } : {}),
        }),
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
        throw error;
      }

      const contentType = response.headers?.get?.("content-type") || "";
      if (response.body && /text\/event-stream/i.test(contentType)) {
        let raw = "";
        const calls = new Map();
        const guard = createAssistantTextGuard(text => sanitizeAssistantIdentity(stripThinking(text)));
        await readSse(response.body, data => {
          const delta = data.choices?.[0]?.delta || {};
          mergeToolCallDelta(calls, delta);
          if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
            onEvent?.({ type: "tool-call-delta", delta: delta.tool_calls });
          }
          const reasoning = delta.reasoning_content ?? delta.reasoning;
          if (typeof reasoning === "string" && reasoning) {
            onEvent?.({ type: "reasoning-delta", text: reasoning });
          }
          const content = delta.content ?? data.choices?.[0]?.message?.content ?? "";
          if (!content) return;
          raw += content;
          const safe = guard.push(content);
          if (safe) {
            if (onEvent) onEvent({ type: "text-delta", text: safe });
            else onToken?.(safe);
          }
        });
        if (calls.size > 0) {
          const completed = guard.finish(raw);
          if (completed.output) {
            if (onEvent) onEvent({ type: "text-delta", text: completed.output });
            else onToken?.(completed.output);
          }
          const result = canonicalToolText(calls);
          onEvent?.({ type: "finish", reason: "tool-calls" });
          return result;
        }
        const completed = guard.finish(raw);
        if (completed.output) {
          if (onEvent) onEvent({ type: "text-delta", text: completed.output });
          else onToken?.(completed.output);
        }
        onEvent?.({ type: "finish", reason: "stop" });
        return completed.text.trim();
      }

      const data = await response.json();
      const message = data.choices?.[0]?.message || {};
      if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
        const calls = new Map();
        mergeToolCallDelta(calls, { tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) });
        const result = canonicalToolText(calls);
        onEvent?.({ type: "finish", reason: "tool-calls" });
        return result;
      }
      const result = sanitizeAssistantIdentity(stripThinking(message.content || "")).trim();
      if (result) {
        if (onEvent) onEvent({ type: "text-delta", text: result });
        else onToken?.(result);
      }
      onEvent?.({ type: "finish", reason: "stop" });
      return result;
    } catch (error) {
      onEvent?.({ type: "error", error });
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortParent);
    }
  }
}
