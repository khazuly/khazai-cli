import { prepareAIChatMessages } from "./aichat-context.js";

function cookieHeader(headers) {
  const values = headers?.getSetCookie?.() || [];
  return values.map(value => String(value).split(";", 1)[0]).filter(Boolean).join("; ");
}

function responseError(status, statusText, detail = "") {
  const error = new Error(`HTTP ${status}: ${statusText || "AIChat request failed"}`);
  error.status = status;
  error.providerDetail = String(detail).slice(0, 1_000);
  return error;
}

async function responseDetail(response) {
  try { return await response.text(); } catch { return ""; }
}

function toolPayload(value) {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    return value.length && value.every(entry => toolPayload(entry)) ? value : null;
  }
  return typeof value.tool === "string" && value.tool.trim()
    && value.args && typeof value.args === "object" && !Array.isArray(value.args)
    ? value
    : null;
}

function normalizeToolReply(output) {
  const candidates = [output.trim(), ...[...output.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(match => match[1]?.trim())];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (toolPayload(parsed)) return JSON.stringify(parsed);
    } catch {}
  }
  return output;
}

async function readSSE(response, { onToken, onEvent, deferTokens = false }) {
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error("AIChat response did not include an SSE body.");
  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";
  let firstByte = true;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstByte) {
        firstByte = false;
        onEvent?.({ type: "first-byte" });
      }
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const payload = event.split("\n").filter(line => line.startsWith("data:"))
          .map(line => line.slice(5).trim()).join("\n");
        if (!payload || payload === "[DONE]") continue;
        let chunk;
        try { chunk = JSON.parse(payload); } catch { continue; }
        const token = chunk.choices?.[0]?.delta?.content;
        if (token) {
          output += token;
          if (!deferTokens) onToken?.(token);
        }
        if (chunk.usage) {
          onEvent?.({
            type: "usage",
            inputTokens: chunk.usage.prompt_tokens ?? null,
            outputTokens: chunk.usage.completion_tokens ?? null,
          });
        }
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  const result = deferTokens ? normalizeToolReply(output) : output;
  if (deferTokens && result) onToken?.(result);
  return result;
}

export class AIChatSessionPool {
  constructor({ fetchImpl = fetch, baseURL = "https://aichat.org", maximum = 64 } = {}) {
    this.fetch = fetchImpl;
    this.baseURL = String(baseURL).replace(/\/+$/, "");
    this.maximum = maximum;
    this.sessions = new Map();
    this.locks = new Map();
  }

  async withSession(sessionId, action) {
    const key = String(sessionId || "default");
    const previous = this.locks.get(key) || Promise.resolve();
    let unlock;
    const gate = new Promise(resolve => { unlock = resolve; });
    this.locks.set(key, gate);
    await previous;
    try {
      const session = this.sessions.get(key) || await this.establish();
      this.sessions.set(key, session);
      session.lastUsedAt = Date.now();
      return await action(session);
    } finally {
      unlock();
      if (this.locks.get(key) === gate) this.locks.delete(key);
    }
  }

  async establish() {
    const response = await this.fetch(`${this.baseURL}/chat`, { redirect: "follow" });
    if (!response.ok) throw responseError(response.status, response.statusText, await responseDetail(response));
    const html = await response.text();
    const match = /<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i.exec(html);
    if (!match) throw new Error("AIChat did not provide a CSRF token.");
    const cookies = cookieHeader(response.headers);
    if (!cookies) throw new Error("AIChat did not provide session cookies.");
    this.trim();
    return { csrf: match[1], cookies, version: 1, lastUsedAt: Date.now() };
  }

  async rotate(sessionId) {
    const next = await this.establish();
    const current = this.sessions.get(String(sessionId || "default"));
    next.version = Number(current?.version || 0) + 1;
    this.sessions.set(String(sessionId || "default"), next);
    return next;
  }

  trim() {
    while (this.sessions.size >= this.maximum) {
      const oldest = [...this.sessions.entries()]
        .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
      if (!oldest) return;
      this.sessions.delete(oldest[0]);
    }
  }
}

const sharedSessions = new AIChatSessionPool();

export class AIChatProvider {
  constructor({ baseURL = "https://aichat.org", sessionPool = sharedSessions, fetchImpl = fetch } = {}) {
    this.id = "aichat";
    this.baseURL = String(baseURL).replace(/\/+$/, "");
    this.sessionPool = sessionPool;
    this.fetch = fetchImpl;
    this.endpoint = `${this.baseURL}/api/chat`;
  }

  chatURL() { return this.endpoint; }

  async usage(session) {
    const response = await this.fetch(`${this.baseURL}/api/chat/usage`, {
      headers: this.headers(session, { Accept: "application/json" }),
    });
    if (!response.ok) return null;
    try { return await response.json(); } catch { return null; }
  }

  headers(session, extra = {}) {
    return {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "X-CSRF-TOKEN": session.csrf,
      Cookie: session.cookies,
      Referer: `${this.baseURL}/chat`,
      Origin: this.baseURL,
      ...extra,
    };
  }

  exhausted(usage) {
    return usage?.limit_exhausted === true || Number(usage?.tokens_remaining) <= 0;
  }

  async request(session, body, options) {
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("Request timed out")),
      Math.max(1_000, Number(options.timeoutMs) || 300_000));
    timer.unref?.();
    try {
      const response = await this.fetch(this.endpoint, {
        method: "POST",
        headers: this.headers(session),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw responseError(response.status, response.statusText, await responseDetail(response));
      const contentType = response.headers?.get?.("content-type") || "";
      if (/text\/html/i.test(contentType)) {
        const error = new Error("AIChat rejected the request context and returned the chat page instead of an SSE response.");
        error.status = 400;
        error.code = "AICHAT_CONTEXT_REJECTED";
        throw error;
      }
      if (!/text\/event-stream/i.test(contentType)) {
        throw new Error("AIChat returned a non-SSE response.");
      }
      return await readSSE(response, { ...options, deferTokens: (options.tools?.length || 0) > 0 });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  async chat(messages, options = {}) {
    const sessionId = options.sessionId || options.turnId || "default";
    const body = {
      model: options.model,
      messages: prepareAIChatMessages(messages, options.tools || []),
    };
    return this.sessionPool.withSession(sessionId, async session => {
      const usage = await this.usage(session);
      if (this.exhausted(usage)) session = await this.sessionPool.rotate(sessionId);
      try {
        const result = await this.request(session, body, options);
        options.onEvent?.({ type: "finish", reason: "stop" });
        return result;
      } catch (error) {
        if (![401, 403, 419].includes(Number(error.status)) && error.code !== "AICHAT_CONTEXT_REJECTED") throw error;
        const fresh = await this.sessionPool.rotate(sessionId);
        const result = await this.request(fresh, body, options);
        options.onEvent?.({ type: "finish", reason: "stop" });
        return result;
      }
    });
  }
}
