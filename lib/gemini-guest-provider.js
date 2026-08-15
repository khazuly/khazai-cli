import { request as httpsRequest } from "node:https";

const BASE_URL = "https://gemini.google.com";
const APP_URL = `${BASE_URL}/app`;
const CHAT_PATH = "/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate";
const DEFAULT_TIMEOUT_MS = 300_000;
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const sessions = new Map();

function cookieHeader(cookies) {
  return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function storeCookies(cookies, response) {
  const getSetCookie = response.headers?.getSetCookie?.bind(response.headers);
  const values = getSetCookie ? getSetCookie() : [response.headers?.get?.("set-cookie")].filter(Boolean);
  for (const header of values) {
    const first = String(header || "").split(";", 1)[0];
    const separator = first.indexOf("=");
    if (separator > 0) cookies.set(first.slice(0, separator), first.slice(separator + 1));
  }
}

function browserHeaders(cookies, post = false) {
  const headers = {
    "user-agent": USER_AGENT,
    "origin": BASE_URL,
    "referer": APP_URL,
    "x-same-domain": "1",
  };
  const cookie = cookieHeader(cookies);
  if (cookie) headers.cookie = cookie;
  if (post) headers["content-type"] = "application/x-www-form-urlencoded;charset=UTF-8";
  return headers;
}

function abortSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const abortParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortParent();
  else parentSignal?.addEventListener("abort", abortParent, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Request timed out")), Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortParent);
    },
  };
}

function nodeRequest(url, { method = "GET", headers = {}, body = "", signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = httpsRequest({
      method,
      hostname: target.hostname,
      path: `${target.pathname}${target.search}`,
      headers,
      maxHeaderSize: 512 * 1024,
      timeout: Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS),
    }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode || 0,
        statusText: res.statusMessage || "",
        headers: {
          get(name) {
            const value = res.headers[String(name || "").toLowerCase()];
            return Array.isArray(value) ? value.join(", ") : value || null;
          },
          getSetCookie() {
            const value = res.headers["set-cookie"];
            return Array.isArray(value) ? value : value ? [value] : [];
          },
        },
        text: async () => Buffer.concat(chunks).toString("utf8"),
      }));
    });
    const onAbort = () => req.destroy(signal?.reason || new Error("Request aborted"));
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    req.on("close", () => signal?.removeEventListener("abort", onAbort));
    if (body) req.write(body);
    req.end();
  });
}

let requestTransport = nodeRequest;

export function setGeminiGuestRequestTransport(transport = nodeRequest) {
  requestTransport = transport || nodeRequest;
}

function unwrapMarkdownLinks(text) {
  return String(text || "").replace(/\[([^\]\s]+:\/\/[^\]\s]+)\]\(\1\)/g, "$1");
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => {
    if (typeof part === "string") return part;
    if (part?.type === "text") return part.text || "";
    return part?.text || "";
  }).join("");
}

function toolsPrompt(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return "";
  const definitions = tools.map(tool => ({
    name: tool.function?.name || tool.name,
    description: String(tool.function?.description || tool.description || ""),
    parameters: tool.function?.parameters || tool.parameters || { type: "object", properties: {} },
  })).filter(tool => tool.name);
  if (!definitions.length) return "";
  return [
    "TOOL CALL PROTOCOL:",
    "When a tool is required, respond with exactly one complete minified JSON object or JSON array and no markdown or prose.",
    "Each call must use {\"tool\":\"name\",\"args\":{...}} with valid JSON values. Use only these tools:",
    JSON.stringify(definitions),
    "Never wrap URLs in Markdown links. URL arguments and shell commands must contain raw URLs like https://example.com, not [https://example.com](https://example.com).",
    "Use a JSON array only for independent read-only calls. Tool results arrive in later user messages.",
  ].join("\n");
}

function promptFromMessages(messages, tools = []) {
  const lines = [];
  for (const message of messages || []) {
    const role = message?.role || "user";
    const text = textFromContent(message?.content).trim();
    if (!text) continue;
    if (role === "system") lines.push(`System instructions:\n${text}`);
    else if (role === "assistant") lines.push(`Assistant:\n${text}`);
    else if (role === "tool") lines.push(`Tool result:\n${text}`);
    else lines.push(`User:\n${unwrapMarkdownLinks(text)}`);
  }
  const protocol = toolsPrompt(tools);
  if (protocol) lines.push(`User:\n${protocol}`);
  return lines.join("\n\n").trim();
}

function findModelName(value) {
  if (typeof value === "string") return /Flash|Gemini/i.test(value) ? value : "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findModelName(item);
      if (found) return found;
    }
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      const found = findModelName(item);
      if (found) return found;
    }
  }
  return "";
}

function parseCandidate(payload, session) {
  try {
    const ids = payload[1];
    if (Array.isArray(ids)) {
      session.conversationId = ids[0] || session.conversationId;
      session.responseId = ids[1] || session.responseId;
    }
    const candidate = payload[4]?.[0];
    if (Array.isArray(candidate)) {
      session.choiceId = candidate[0] || session.choiceId;
      const parts = candidate[1];
      if (Array.isArray(parts)) return parts.filter(part => part != null).join("").trim();
    }
  } catch {
    return "";
  }
  return "";
}

function parseStreamGenerate(raw, session) {
  const texts = [];
  let modelName = "";
  for (const line of String(raw || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("[[")) continue;
    let events;
    try { events = JSON.parse(trimmed); } catch { continue; }
    for (const event of events) {
      if (!Array.isArray(event) || event[0] !== "wrb.fr" || !event[2]) continue;
      let payload;
      try { payload = JSON.parse(event[2]); } catch { continue; }
      const text = parseCandidate(payload, session);
      if (text) texts.push(text);
      modelName ||= findModelName(payload);
    }
  }
  return { text: texts.at(-1) || "", modelName };
}

function sessionKey(options) {
  return String(options.sessionId || options.runId || options.requestId || "default");
}

export class GeminiGuestProvider {
  constructor() {
    this.id = "gemini-guest";
    this.endpoint = `${BASE_URL}${CHAT_PATH}`;
  }

  chatURL() { return this.endpoint; }

  async init(session, signal, timeoutMs) {
    if (session.bl) return;
    const scoped = abortSignal(signal, timeoutMs);
    try {
      const response = await requestTransport(APP_URL, { headers: browserHeaders(session.cookies), signal: scoped.signal, timeoutMs });
      storeCookies(session.cookies, response);
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText || "Gemini app request failed"}`);
      const html = await response.text();
      const match = html.match(/"cfb2h"\s*:\s*"([^"]+)"/);
      if (!match) throw new Error("Gemini guest parameter cfb2h was not found.");
      session.bl = match[1];
    } finally {
      scoped.cleanup();
    }
  }

  async chat(messages, options = {}) {
    const session = sessions.get(sessionKey(options)) || {
      cookies: new Map(),
      bl: "",
      conversationId: "",
      responseId: "",
      choiceId: "",
      reqid: Math.floor(1000 + Math.random() * 9000),
    };
    sessions.set(sessionKey(options), session);
    await this.init(session, options.signal, options.timeoutMs);

    const prompt = promptFromMessages(messages, options.tools || []);
    if (!prompt) return "";

    const params = new URLSearchParams({ bl: session.bl, reqid: String(session.reqid), rt: "c" });
    session.reqid += 100000;
    const messageStruct = [[prompt], null, [session.conversationId, session.responseId, session.choiceId]];
    const form = new URLSearchParams({
      "f.req": JSON.stringify([null, JSON.stringify(messageStruct)]),
    });
    options.onEvent?.({
      type: "request-prepared",
      timings: { requestBytes: Buffer.byteLength(String(form), "utf-8") },
    });

    const scoped = abortSignal(options.signal, options.timeoutMs);
    try {
      const response = await requestTransport(`${this.endpoint}?${params}`, {
        method: "POST",
        headers: browserHeaders(session.cookies, true),
        body: String(form),
        signal: scoped.signal,
        timeoutMs: options.timeoutMs,
      });
      storeCookies(session.cookies, response);
      const raw = await response.text();
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}: ${response.statusText || "Gemini guest request failed"}`);
        error.status = response.status;
        error.providerDetail = raw.slice(0, 1_000);
        error.endpoint = this.endpoint;
        throw error;
      }
      const result = parseStreamGenerate(raw, session);
      if (!result.text) throw new Error(`Gemini guest response could not be parsed: ${raw.slice(0, 1_000)}`);
      const text = result.text.trim();
      options.onEvent?.({ type: "text-delta", text });
      options.onEvent?.({ type: "finish", reason: "stop" });
      if (result.modelName) {
        options.onEvent?.({ type: "usage", model: result.modelName, inputTokens: 0, outputTokens: 0, totalTokens: 0 });
      }
      return text;
    } catch (error) {
      error.endpoint ||= this.endpoint;
      error.messageCount ??= Array.isArray(messages) ? messages.length : 0;
      error.toolCount ??= 0;
      options.onEvent?.({ type: "error", error });
      throw error;
    } finally {
      scoped.cleanup();
    }
  }
}
