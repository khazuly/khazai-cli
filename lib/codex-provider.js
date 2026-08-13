import { randomUUID } from "node:crypto";
import { createAssistantTextGuard, sanitizeAssistantIdentity } from "./assistant-text.js";
import { validateToolSchemas } from "./provider-reliability.js";
import { AUTH_PATH, getProviderAuth, saveProviderAuth } from "./auth.js";
import { refreshCodexAuth } from "./codex-auth.js";
import { toProviderMessages } from "./providers.js";

export const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

function parseEvent(event) {
  const text = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
  if (!text || text === "[DONE]") return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function readEvents(body, onEvent, onFirstChunk) {
  const decoder = new TextDecoder();
  let buffer = "";
  let firstChunk = true;
  for await (const chunk of body) {
    if (firstChunk) {
      firstChunk = false;
      onFirstChunk?.();
    }
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const event = parseEvent(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      if (event) onEvent(event);
    }
  }
  const event = parseEvent(buffer.replace(/\r\n/g, "\n"));
  if (event) onEvent(event);
}

function inputFromMessages(messages) {
  const input = [];
  let instructions = "";
  for (const message of messages) {
    if (message.role === "system") {
      instructions += `${instructions ? "\n\n" : ""}${message.content || ""}`;
      continue;
    }
    if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.tool_call_id, output: message.content || "" });
      continue;
    }
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) input.push({
        type: "function_call",
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments || "{}",
      });
      continue;
    }
    input.push({
      type: "message",
      role: message.role === "assistant" ? "assistant" : "user",
      content: [{ type: message.role === "assistant" ? "output_text" : "input_text", text: String(message.content || "") }],
    });
  }
  return { input, instructions };
}

function responseTools(tools) {
  return tools.map(tool => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    strict: false,
  }));
}

function resultFromCalls(calls) {
  const output = [...calls.values()].filter(call => call.name).map(call => {
    let args = {};
    try { args = JSON.parse(call.arguments || "{}"); } catch {}
    return { tool: call.name, args, id: call.id };
  });
  return JSON.stringify(output.length === 1 ? output[0] : output);
}

function retryableCodexStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function codexStreamError(event) {
  const source = event.error || event.response?.error || event.response?.incomplete_details || {};
  const message = source.message || source.reason || "Codex could not complete the response.";
  const error = new Error(message);
  const status = Number(source.status || source.status_code || event.status);
  if (Number.isFinite(status) && status > 0) error.status = status;
  error.code = source.code || event.type;
  error.providerDetail = JSON.stringify(event).slice(0, 1_000);
  if (event.type === "response.failed" || retryableCodexStatus(status)) {
    error.failureClass = retryableCodexStatus(status) || !Number.isFinite(status) ? "provider_infrastructure" : undefined;
  }
  if (event.type === "response.incomplete" && /timeout|server|rate|overload|capacity|interrupt/i.test(message)) {
    error.failureClass = "provider_infrastructure";
  }
  return error;
}

export class CodexResponsesProvider {
  constructor({ model, endpoint = CODEX_ENDPOINT, authPath = AUTH_PATH } = {}) {
    this.model = model;
    this.endpoint = endpoint;
    this.authPath = authPath;
    this.refreshing = null;
  }

  async auth() {
    let auth = getProviderAuth("codex", this.authPath);
    if (!auth?.access) throw new Error("Codex login is required. Run: khazai-ai auth login codex");
    if (Number(auth.expires || 0) > Date.now() + 30_000) return auth;
    if (!this.refreshing) this.refreshing = refreshCodexAuth(auth).then(next => {
      saveProviderAuth("codex", next, this.authPath);
      return next;
    }).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async listModels({ signal } = {}) {
    const auth = await this.auth();
    const response = await fetch(`${this.endpoint.replace(/\/responses$/, "/models")}?client_version=1.0.0`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${auth.access}`,
        "ChatGPT-Account-Id": auth.accountId || "",
        originator: "opencode",
        "User-Agent": "opencode/khazai-ai",
      },
      signal,
    });
    if (!response.ok) throw new Error(`Codex model discovery failed with HTTP ${response.status}.`);
    const data = await response.json();
    const entries = Array.isArray(data) ? data : data.data || data.models || data.items || [];
    return entries
      .map(entry => typeof entry === "string" ? entry : entry.slug || entry.id || entry.model)
      .filter(Boolean)
      .sort();
  }

  async chat(messages, {
    model = this.model,
    signal,
    timeoutMs = 300_000,
    onToken,
    onEvent,
    reasoningEffort,
    tools = [],
    capabilities = {},
    parallelToolCalls = false,
  } = {}) {
    const auth = await this.auth();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("Request timed out")), timeoutMs);
    try {
      const converted = inputFromMessages(toProviderMessages(messages));
      const validatedTools = validateToolSchemas(tools);
      if (validatedTools.length > 0 && capabilities.supportsToolCalling === false) {
        const error = new Error("The resolved model route does not support tool calling.");
        error.code = "UNSUPPORTED_TOOLS";
        error.failureClass = "unhealthy_tool_route";
        throw error;
      }
      const requestTools = capabilities.supportsToolCalling === false ? [] : validatedTools;
      const body = {
        model,
        instructions: converted.instructions,
        input: converted.input,
        stream: true,
        store: false,
        ...(reasoningEffort && capabilities.supportsReasoningEffort !== false
          ? { reasoning: { effort: reasoningEffort, summary: "auto" } }
          : {}),
        tools: responseTools(requestTools),
        tool_choice: requestTools.length > 0 ? "auto" : "none",
        ...(capabilities.supportsParallelTools && parallelToolCalls
          ? { parallel_tool_calls: true }
          : {}),
      };
      if (body.reasoning) body.include = ["reasoning.encrypted_content"];
      const response = await fetch(this.endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${auth.access}`,
          "OpenAI-Beta": "responses=experimental",
          "ChatGPT-Account-Id": auth.accountId || "",
          originator: "opencode",
          "User-Agent": "opencode/khazai-ai",
          "session-id": randomUUID(),
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        const error = new Error(`HTTP ${response.status}: ${response.statusText || "Provider request failed"}`);
        error.status = response.status;
        error.providerDetail = detail.slice(0, 1_000);
        error.requestId = response.headers?.get?.("x-request-id")
          || response.headers?.get?.("request-id")
          || "";
        error.endpoint = this.endpoint;
        error.messageCount = messages.length;
        error.toolCount = requestTools.length;
        error.streaming = true;
        error.payloadFields = Object.keys(body);
        error.streamPhase = "response";
        if (retryableCodexStatus(response.status)) error.failureClass = "provider_infrastructure";
        const retryAfter = Number(response.headers?.get?.("retry-after"));
        if (Number.isFinite(retryAfter) && retryAfter >= 0) error.retryAfterMs = retryAfter * 1_000;
        throw error;
      }
      const guard = createAssistantTextGuard(text => sanitizeAssistantIdentity(text));
      const calls = new Map();
      let raw = "";
      let providerError = null;
      const emitText = text => {
        if (!text) return;
        raw += text;
        const safe = guard.push(text);
        if (safe) onEvent ? onEvent({ type: "text-delta", text: safe }) : onToken?.(safe);
      };
      await readEvents(
        response.body,
        event => {
          if (event.type === "response.completed" && event.response?.usage) {
          onEvent?.({
            type: "usage",
            inputTokens: event.response.usage.input_tokens,
            outputTokens: event.response.usage.output_tokens,
            model: event.response.model || model,
          });
        }
        if (event.type === "response.output_text.delta" && event.delta) {
          emitText(event.delta);
        }
        if (event.type === "response.reasoning_summary_text.delta" && event.delta) onEvent?.({ type: "reasoning-delta", text: event.delta });
        if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
          calls.set(event.output_index, { id: event.item.call_id, name: event.item.name, arguments: event.item.arguments || "" });
        }
        if (event.type === "response.function_call_arguments.delta") {
          const call = calls.get(event.output_index) || { id: event.call_id, name: event.name, arguments: "" };
          call.arguments += event.delta || "";
          calls.set(event.output_index, call);
          onEvent?.({ type: "tool-call-delta", delta: [{ index: event.output_index, id: call.id, function: { name: call.name, arguments: event.delta || "" } }] });
        }
        if (event.type === "response.function_call_arguments.done") {
          calls.set(event.output_index, { id: event.call_id, name: event.name, arguments: event.arguments || "{}" });
        }
        if (event.type === "response.output_item.done") {
          if (event.item?.type === "function_call") {
            calls.set(event.output_index, {
              id: event.item.call_id,
              name: event.item.name,
              arguments: event.item.arguments || "{}",
            });
          }
          if (event.item?.type === "message" && !raw) {
            const text = (event.item.content || [])
              .filter(part => part?.type === "output_text")
              .map(part => part.text || "")
              .join("");
            emitText(text);
          }
        }
        if (event.type === "response.completed" && !raw && !calls.size) {
          const text = (event.response?.output || []).flatMap(item => item.content || [])
            .filter(part => part?.type === "output_text")
            .map(part => part.text || "")
            .join("");
          emitText(text);
        }
        if (event.type === "error" || event.type === "response.failed" || event.type === "response.incomplete") {
          providerError = codexStreamError(event);
        }
      }, () => onEvent?.({ type: "first-byte" }));
      if (providerError) throw providerError;
      const completed = guard.finish(raw);
      if (completed.output) onEvent ? onEvent({ type: "text-delta", text: completed.output }) : onToken?.(completed.output);
      if (calls.size) {
        onEvent?.({ type: "finish", reason: "tool-calls" });
        return resultFromCalls(calls);
      }
      onEvent?.({ type: "finish", reason: "stop" });
      return completed.text.trim();
    } catch (error) {
      error.endpoint ||= this.endpoint;
      error.messageCount ??= Array.isArray(messages) ? messages.length : 0;
      error.toolCount ??= Array.isArray(tools) ? tools.length : 0;
      error.streaming ??= true;
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}
