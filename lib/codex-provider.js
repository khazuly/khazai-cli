import { randomUUID } from "node:crypto";
import { createAssistantTextGuard, sanitizeAssistantIdentity } from "./assistant-text.js";
import { AUTH_PATH, getProviderAuth, saveProviderAuth } from "./auth.js";
import { refreshCodexAuth } from "./codex-auth.js";
import { toProviderMessages } from "./providers.js";

export const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

function parseEvent(event) {
  const text = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
  if (!text || text === "[DONE]") return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function readEvents(body, onEvent) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
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

  async chat(messages, { model = this.model, signal, timeoutMs = 300_000, onToken, onEvent, reasoningEffort, tools = [] } = {}) {
    const auth = await this.auth();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("Request timed out")), timeoutMs);
    try {
      const converted = inputFromMessages(toProviderMessages(messages));
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
        body: JSON.stringify({
          model,
          instructions: converted.instructions,
          input: converted.input,
          stream: true,
          store: false,
          include: ["reasoning.encrypted_content"],
          ...(reasoningEffort ? { reasoning: { effort: reasoningEffort, summary: "auto" } } : {}),
          tools: responseTools(tools),
          tool_choice: "auto",
          parallel_tool_calls: false,
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText} - ${(await response.text()).slice(0, 200)}`);
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
      await readEvents(response.body, event => {
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
          providerError = event.error?.message || event.response?.error?.message || "Codex could not complete the response.";
        }
      });
      if (providerError) throw new Error(providerError);
      const completed = guard.finish(raw);
      if (completed.output) onEvent ? onEvent({ type: "text-delta", text: completed.output }) : onToken?.(completed.output);
      if (calls.size) {
        onEvent?.({ type: "finish", reason: "tool-calls" });
        return resultFromCalls(calls);
      }
      onEvent?.({ type: "finish", reason: "stop" });
      return completed.text.trim();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}
