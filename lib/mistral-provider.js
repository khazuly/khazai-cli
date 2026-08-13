import { randomUUID } from "node:crypto";
import { createSession } from "wreq-js";
import { canonicalToolText } from "./stream-normalizer.js";
const API_BASE = "https://chat.mistral.ai";
const VIBE_MODEL = "vibe";
const DEFAULT_FEATURES = [];
const SUPPORTED_CALLBACKS = [];
const DEFAULT_RETRIES = 2;
const BROWSER_PROFILE = "chrome_126";
const OS_PROFILE = "windows";
const LANDING_HEADERS = { "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7" };
const JSON_API_HEADERS = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Origin": API_BASE, "Referer": `${API_BASE}/chat` };
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;
const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const upstreamSessions = new Map();
let sessionFactory = createSession;

export function setMistralSessionFactory(factory = createSession) {
  sessionFactory = factory || createSession;
}
class ApiError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}: ${body}`);
    this.status = status;
  }
}
function features() {
  const configured = process.env.MISTRAL_FEATURES;
  if (configured === undefined) return DEFAULT_FEATURES;
  return configured.split(",").map(item => item.trim()).filter(Boolean);
}
function userTimezone() {
  const offset = -new Date().getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const minutes = String(Math.abs(offset) % 60).padStart(2, "0");
  let zone = "";
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { zone = ""; }
  return `T${sign}${hours}:${minutes}${zone ? ` (${zone})` : ""}`;
}
function debug(name, start) {
  if (process.env.MISTRAL_DEBUG === "1") {
    console.error(`[vibe:debug] ${name}: ${Math.round(performance.now() - start)}ms`);
  }
}
function sessionState(key) {
  if (key) {
    const existing = upstreamSessions.get(key);
    if (existing) return existing;
  }
  const state = {
    key,
    session: null,
    providerSessionId: "",
    conversationId: null,
    cookieJar: null,
    clientId: "",
    transportRevision: 0,
    lastUsedAt: 0,
    messageId: null,
    sentCount: 0,
    sentTail: "",
    model: "",
    identityReady: false,
    pending: null,
  };
  if (key) upstreamSessions.set(key, state);
  return state;
}
async function getSession(state) {
  if (state.session && !state.session.closed) return state.session;
  const start = performance.now();
  const session = await sessionFactory({ browser: BROWSER_PROFILE, os: OS_PROFILE });
  state.session = session;
  state.cookieJar = session;
  state.providerSessionId = String(session.id || state.providerSessionId || "");
  state.transportRevision += 1;
  const seeded = process.env.MISTRAL_COOKIE || "";
  if (seeded) {
    for (const part of seeded.split(";")) {
      const pair = part.trim();
      if (!pair || !pair.includes("=")) continue;
      const eq = pair.indexOf("=");
      session.setCookie(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim(), API_BASE + "/");
    }
    state.clientId = session.getCookies(API_BASE + "/").anonymousUser || "";
    state.identityReady = true;
  }
  debug("session creation", start);
  return session;
}
async function rotateTransport(state) {
  if (state.session && !state.session.closed) {
    try { await state.session.close(); } catch {}
  }
  state.session = null;
  state.cookieJar = null;
  state.providerSessionId = "";
  state.identityReady = false;
  state.clientId = "";
  state.conversationId = null;
  state.messageId = null;
  state.sentCount = 0;
  state.sentTail = "";
}
function resetConversation(state) {
  state.conversationId = null;
  state.messageId = null;
  state.sentCount = 0;
  state.sentTail = "";
}
function isValidConversationId(id) {
  return typeof id === "string" && CONVERSATION_ID_PATTERN.test(id);
}
async function ensureIdentity(state, signal) {
  if (state.identityReady) return;
  const session = await getSession(state);
  const start = performance.now();
  let cookieSource = session.getCookies(API_BASE + "/");
  if (!cookieSource || Object.keys(cookieSource).length === 0) {
    const response = await session.fetch(API_BASE + "/", { signal, headers: LANDING_HEADERS });
    if (response.status !== 200 || (await response.text()).slice(0, 400).includes("Just a moment")) {
      const error = new Error(`Cloudflare block (HTTP ${response.status})`);
      error.status = response.status;
      throw error;
    }
    cookieSource = session.getCookies(API_BASE + "/");
  }
  state.clientId = cookieSource.anonymousUser || state.clientId || "";
  state.identityReady = true;
  debug("cookie bootstrap", start);
}
async function apiErrorFrom(response) {
  const body = await response.text().catch(() => "");
  const error = new ApiError(response.status, body.slice(0, 300));
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) error.retryAfterMs = seconds * 1_000;
  }
  return error;
}
async function createChat(state, text, signal) {
  const body = { "0": { "json": { "content": [{ "type": "text", "text": text }], "transcriptionsMetadata": [], "incognito": false, "files": [], "features": features(), "integrations": [], "libraries": [], "productType": "chat" } } };
  const start = performance.now();
  const response = await state.session.fetch(`${API_BASE}/api/trpc/message.newChat?batch=1`, {
    method: "POST",
    signal,
    headers: JSON_API_HEADERS,
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await apiErrorFrom(response);
  const payload = await response.json().catch(() => null);
  const data = payload?.[0]?.result?.data?.json;
  const chatId = data?.chatId;
  const messageId = data?.messages?.id;
  if (typeof chatId !== "string" || typeof messageId !== "string") {
    throw new ApiError(response.status, `unexpected newChat response: ${String(payload || "").slice(0, 300)}`);
  }
  debug("conversation resolution", start);
  return [chatId, messageId];
}
function sendMessage(state, conversationId, messageId, text, signal) {
  const payload = {
    chatId: conversationId,
    mode: "append", messageInput: [{ "type": "text", "text": text }],
    messageFiles: [], messageId, features: features(), libraries: [], integrations: [],
    disabledFeatures: [], reviewComments: [], preventFeaturesAndIntegrationsPersistence: false,
    transcriptionsMetadata: [], clientPromptData: { currentDate: new Date().toISOString().slice(0, 10), userTimezone: userTimezone() },
    stableAnonymousIdentifier: state.clientId || state.session.getCookies(API_BASE + "/").anonymousUser || "",
    supportedTaskCallbacks: SUPPORTED_CALLBACKS, boostMode: false,
  };
  return state.session.fetch(`${API_BASE}/api/chat`, {
    method: "POST",
    signal,
    headers: JSON_API_HEADERS,
    body: JSON.stringify(payload),
  });
}
function parseLine(line) {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  try {
    const event = JSON.parse(line.slice(colon + 1));
    const data = event?.json;
    if (!data || data.type !== "message") return null;
    return data;
  } catch {
    return null;
  }
}
function applyPatches(buffers, data) {
  const patches = data.patches || [];
  let model = null;
  for (const patch of patches) {
    if (patch.path === "/model" && typeof patch.value === "string") model = patch.value;
    const op = patch.op;
    const path = patch.path || "";
    const value = patch.value;
    if (op === "replace" && path === "/contentChunks") {
      for (const key of Object.keys(buffers)) delete buffers[key];
      for (const [index, chunk] of (value || []).entries()) buffers[index] = [chunk?.text || ""];
    } else if (path.startsWith("/contentChunks/") && path.endsWith("/text")) {
      const index = Number(path.split("/")[2]);
      if (!Number.isInteger(index)) continue;
      const text = value || "";
      if (op === "replace") buffers[index] = [text];
      else (buffers[index] ||= []).push(text);
    }
  }
  return model;
}
function fullText(buffers) {
  return Object.keys(buffers)
    .sort((left, right) => Number(left) - Number(right))
    .map(index => buffers[index].join(""))
    .join("");
}
async function consumeStream(response, { emitText, emitCall, emitFirstByte, toolStream }) {
  const contentType = response.headers?.get?.("content-type") || "";
  if (!response.body || !/text\/event-stream/i.test(contentType)) {
    throw new ApiError(response.status, (await response.text().catch(() => "")).slice(0, 300));
  }
  const start = performance.now();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const buffers = {};
  let buffer = "";
  let answer = "";
  let model = "";
  let firstByteSent = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!firstByteSent) {
      firstByteSent = true;
      emitFirstByte();
      debug("first response byte", start);
    }
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 1);
      if (!line) continue;
      const data = parseLine(line);
      if (!data) continue;
      const observed = applyPatches(buffers, data);
      if (observed) model = observed;
      const full = fullText(buffers);
      if (full.length > answer.length) {
        const delta = full.slice(answer.length);
        answer = full;
        const chunk = toolStream.push(delta);
        if (chunk.text) emitText(chunk.text);
        for (const call of chunk.calls) emitCall(call);
      }
    }
  }
  const tail = toolStream.finish();
  if (tail.text) emitText(tail.text);
  debug("stream completion", start);
  return model;
}
function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(part => (typeof part === "string" ? part : part?.text || ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}
function toolsPrompt(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return "";
  const lines = ["=== AVAILABLE TOOLS ==="];
  for (const tool of tools) {
    const fn = tool?.function || tool || {};
    const name = fn.name || tool?.name || "";
    if (!name) continue;
    const description = String(fn.description || "").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    const parameters = fn.parameters || tool?.inputSchema || tool?.schema || { type: "object", properties: {} };
    lines.push(`<tool name="${name}" description="${description}">`);
    lines.push(`<schema>${JSON.stringify(parameters)}</schema>`);
    lines.push("</tool>");
  }
  lines.push(
    "",
    "=== TOOL USAGE RULES ===",
    "- If you need to call a tool, output a JSON block in exactly this format, one block per tool, on its own line:",
    '<tool_call>{"name":"tool_name","arguments":{...}}</tool_call>',
    "- Do not add any text inside the tool_call block.",
    "- After a tool finishes executing, its result will be sent back to you.",
    "- If you do not need a tool, answer directly without a tool_call block.",
  );
  return lines.join("\n");
}
export function mistralMessagesToContext(messages, { tools = [] } = {}) {
  const parts = [];
  const toolSection = toolsPrompt(tools);
  if (toolSection) parts.push(toolSection);
  const lines = [];
  for (const message of messages || []) {
    const role = message?.role;
    const content = messageText(message);
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (role === "system" && content) {
      lines.push(`System: ${content}`);
    } else if (role === "assistant" && calls.length > 0) {
      const summary = calls.map(call => `"${call.function?.name || call.name || ""}" with arguments ${call.function?.arguments || call.arguments || "{}"}`).join("; ");
      lines.push(`Assistant: I called tool ${summary}${content ? `\n${content}` : ""}`);
    } else if (role === "assistant" && content) {
      lines.push(`Assistant: ${content}`);
    } else if (role === "tool") {
      lines.push(`Tool result (${message.tool_call_id || "tool"}): ${content}`);
    } else if (role === "user" && content) {
      lines.push(`User: ${content}`);
    } else if (content) {
      lines.push(`${role || "message"}: ${content}`);
    }
  }
  if (lines.length > 0) parts.push(lines.join("\n"));
  return parts.join("\n\n");
}
const TOOL_BLOCK = /<tool_call>([\s\S]*?)<\/tool_call>/g;
export class ToolCallStream {
  constructor() {
    this._buffer = "";
    this._emitted = 0;
  }
  push(chunk) {
    this._buffer += chunk;
    const out = { text: "", calls: [] };
    TOOL_BLOCK.lastIndex = this._emitted;
    let match;
    while ((match = TOOL_BLOCK.exec(this._buffer))) {
      out.text += this._buffer.slice(this._emitted, match.index);
      this._emitted = match.index + match[0].length;
      try {
        const data = JSON.parse(match[1]);
        const name = String(data.name || data.tool || "");
        const args = data.arguments ?? data.args ?? {};
        if (name) {
          out.calls.push({ name, arguments: typeof args === "string" ? args : JSON.stringify(args) });
        }
      } catch {
        out.text += match[0];
      }
    }
    const openIndex = this._buffer.indexOf("<tool_call>", this._emitted);
    if (openIndex >= 0) {
      out.text += this._buffer.slice(this._emitted, openIndex);
      this._emitted = openIndex;
    } else {
      out.text += this._buffer.slice(this._emitted);
      this._emitted = this._buffer.length;
    }
    return out;
  }
  finish() {
    const tail = this._buffer.slice(this._emitted);
    const unclosed = tail.includes("<tool_call>") && !tail.includes("</tool_call>");
    return { text: unclosed ? "" : tail };
  }
}
function deliveryTailMatches(state, messages) {
  if (state.sentCount <= 0 || state.sentCount > messages.length) return false;
  const tail = messages[state.sentCount - 1];
  return Boolean(tail) && state.sentTail === JSON.stringify([tail.role, messageText(tail)]);
}
function enqueue(key, task) {
  const state = sessionState(key);
  const previous = state.pending || Promise.resolve();
  const run = previous.catch(() => {}).then(() => task(state));
  state.pending = run;
  return run.finally(() => {
    if (state.pending === run) state.pending = null;
  });
}
function backoffMs(attempt, error) {
  const exponential = Math.round(RETRY_BASE_MS * 2 ** attempt * (0.8 + Math.random() * 0.4));
  const requested = Number(error?.retryAfterMs);
  if (Number.isFinite(requested) && requested > 0) {
    return Math.min(Math.max(exponential, Math.min(requested, RETRY_MAX_MS)), RETRY_MAX_MS);
  }
  return Math.min(exponential, RETRY_MAX_MS);
}
function waitForBackoff(ms, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal.reason || new Error("Cancelled")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    timer.unref?.();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}
async function runChatAttempts(state, { messages, signal, onEvent, onToken, tools }) {
  const maxRetries = Math.max(1, Number(process.env.MISTRAL_RETRIES) || DEFAULT_RETRIES);
  let recovered = false;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const toolStream = new ToolCallStream();
    const collected = [], calls = [];
    let callIndex = 0, clean = "", phase = "";
    const emitText = text => { if (text) { clean += text; collected.push({ type: "text-delta", text }); } };
    const emitCall = call => { const index = callIndex++; const id = `call_${index}`; calls.push({ id, ...call }); collected.push({ type: "tool-call-delta", delta: [{ index, id, type: "function", function: { name: call.name, arguments: call.arguments } }] }); };
    const emitFirstByte = () => collected.push({ type: "first-byte" });
    try {
      const identityPromise = ensureIdentity(state, signal);
      const canReuse = state.conversationId != null && isValidConversationId(state.conversationId) && deliveryTailMatches(state, messages);
      const delta = canReuse ? mistralMessagesToContext(messages.slice(state.sentCount), { tools: [] }) : "";
      const full = delta.trim() ? "" : mistralMessagesToContext(messages, { tools });
      await identityPromise;
      const revision = state.transportRevision;
      const sendStart = performance.now();
      debug("payload construction", sendStart);
      let response;
      if (full) {
        phase = "newChat";
        const [conversationId, messageId] = await createChat(state, full, signal);
        state.conversationId = conversationId;
        state.messageId = messageId;
        phase = "send";
        response = await sendMessage(state, conversationId, messageId, full, signal);
      } else {
        phase = "send";
        response = await sendMessage(state, state.conversationId, randomUUID(), delta, signal);
      }
      debug("request start", sendStart);
      if (!response.ok) throw await apiErrorFrom(response);
      const result = await consumeStream(response, { emitText, emitCall, emitFirstByte, toolStream });
      if (state.transportRevision !== revision) throw new Error("stale transport revision");
      if (result) state.model = result;
      state.sentCount = messages.length;
      state.sentTail = JSON.stringify([(messages[messages.length - 1] || {}).role, messageText(messages[messages.length - 1])]);
      state.lastUsedAt = Date.now();
      if (onEvent) for (const event of collected) onEvent(event);
      else if (onToken) for (const event of collected) if (event.type === "text-delta" && event.text) onToken(event.text);
      if (calls.length > 0) {
        onEvent?.({ type: "finish", reason: "tool-calls" });
        return canonicalToolText(calls);
      }
      onEvent?.({ type: "finish", reason: "stop" });
      return clean.trim();
    } catch (caught) {
      if (signal.aborted) throw caught;
      const status = Number(caught?.status);
      if (status === 404 && phase === "send" && !recovered) {
        resetConversation(state);
        recovered = true;
        continue;
      }
      const retryable = status === 401 || status === 403 || status === 429 || status >= 500 || !Number.isFinite(status);
      const allowRetry = retryable && attempt < maxRetries - 1 && !((status === 401 || status === 403) && attempt >= 1);
      if (!allowRetry) throw caught;
      if (status === 401 || status === 403 || status === 429 || !Number.isFinite(status)) await rotateTransport(state);
      const delay = backoffMs(attempt, caught);
      const delayStart = performance.now();
      await waitForBackoff(delay, signal);
      debug("retry/refresh delay", delayStart);
    }
  }
}

export class MistralLeChatProvider {
  constructor() {
    this.id = "mistral";
  }
  chatURL() { return API_BASE; }
  async listModels() {
    return [VIBE_MODEL];
  }
  async chat(messages, options = {}) {
    const { onEvent, signal, tools = [], sessionId = "" } = options;
    const timeoutMs = Math.max(1_000, Number(options.timeoutMs) || 300_000);
    const key = String(sessionId || "");
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason || new Error("Cancelled"));
    if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await enqueue(key, async state => {
        if (controller.signal.aborted) throw controller.signal.reason || new Error("Cancelled");
        const timer = setTimeout(() => controller.abort(new Error("Request timed out")), timeoutMs);
        try {
          return await runChatAttempts(state, { messages, signal: controller.signal, onEvent, onToken: options.onToken, tools });
        } finally {
          clearTimeout(timer);
        }
      });
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
