const BASE = "https://aichat.org";

const SHORTCUTS = {
  gpt: "openai/gpt-4o-mini",
  claude: "anthropic/claude-haiku-4-5",
  qwen: "qwen/qwen-2.5-72b-instruct",
};
const REMOVED_MODELS = new Set(["gemini", "deepseek", "grok"]);

function resolveModel(m) {
  const requested = m?.toLowerCase();
  if (REMOVED_MODELS.has(requested)) throw new Error(`Model "${m}" is no longer supported.`);
  return SHORTCUTS[requested] || m || SHORTCUTS.gpt;
}

// Persistent cookie jar (mirror of requests.Session)
const _cookies = new Map();

function saveCookies(res) {
  for (const c of (res.headers.getSetCookie?.() || [])) {
    const [pair] = c.split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) _cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1));
  }
}

function cookieHeader() {
  if (_cookies.size === 0) return "";
  return Array.from(_cookies.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
let _csrf = null;
let _sessionPromise = null;

function requestSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const abortParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal) {
    if (parentSignal.aborted) abortParent();
    else parentSignal.addEventListener("abort", abortParent, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error("Request timed out")), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortParent);
    },
  };
}

function normalizeRequestError(error, signal) {
  if (signal.aborted) {
    const reason = signal.reason;
    return reason instanceof Error ? reason : new Error("Request aborted");
  }
  return error;
}

export async function ensureSession(opts = {}) {
  if (_cookies.size > 0 && _csrf) return;
  if (!_sessionPromise) {
    _sessionPromise = _initSession(opts).finally(() => { _sessionPromise = null; });
  }
  await _sessionPromise;
}

async function _initSession(opts = {}) {
  const request = requestSignal(opts.signal, opts.timeoutMs || CHAT_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/chat`, {
      signal: request.signal,
      headers: {
        "User-Agent": UA,
        Origin: BASE,
        Referer: `${BASE}/chat`,
      },
    });
    if (!res.ok) throw new Error(`Session HTTP ${res.status}: ${res.statusText}`);
    const html = await res.text();
    const m = html.match(/<meta name="csrf-token" content="([^"]+)"/);
    if (!m) throw new Error("Could not extract CSRF token");
    saveCookies(res);
    _csrf = m[1];
  } catch (error) {
    throw normalizeRequestError(error, request.signal);
  } finally {
    request.cleanup();
  }
}

export async function resetSession(opts = {}) {
  _cookies.clear();
  _csrf = null;
  await ensureSession(opts);
}

const CHAT_TIMEOUT_MS = 60_000;
const CHUNK_IDLE_MS = 30_000;
const MAX_OUTPUT_TOKENS = 8_192;

export async function chat(messages, opts = {}) {
  const model = resolveModel(opts.model);
  const request = requestSignal(opts.signal, opts.timeoutMs || CHAT_TIMEOUT_MS);

  try {
    await ensureSession({ signal: request.signal, timeoutMs: opts.timeoutMs || CHAT_TIMEOUT_MS });
    const res = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      signal: request.signal,
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-TOKEN": _csrf,
        Accept: "text/event-stream",
        Cookie: cookieHeader(),
        Origin: BASE,
        Referer: `${BASE}/chat`,
        "User-Agent": UA,
      },
      // The provider's implicit output cap can truncate large write/edit JSON
      // in the middle of the content string. Request enough room for a
      // complete tool payload; the Agent still applies its own turn limits.
      body: JSON.stringify({
        model,
        messages,
        max_tokens: opts.maxTokens || MAX_OUTPUT_TOKENS,
      }),
    });

    if (res.status === 429) throw new Error("Rate limited (429)");
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${res.statusText}${body ? " - " + body.slice(0, 200) : ""}`);
    }

    saveCookies(res);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result = "";
    let done = false;

    while (!done) {
      let chunkTimer;
      const chunkPromise = new Promise((_, reject) => {
        chunkTimer = setTimeout(() => reject(new Error("SSE chunk timeout")), CHUNK_IDLE_MS);
      });

      try {
        const chunk = await Promise.race([reader.read(), chunkPromise]);
        clearTimeout(chunkTimer);
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") { done = true; break; }
          try {
            const delta = JSON.parse(data).choices?.[0]?.delta?.content;
            if (delta) {
              result += delta;
              if (opts.onToken) opts.onToken(delta);
            }
          } catch {}
        }
      } catch (e) {
        clearTimeout(chunkTimer);
        if (e.message === "SSE chunk timeout") throw e;
        if (e.name === "AbortError") throw normalizeRequestError(e, request.signal);
        throw e;
      }
    }
    return result;
  } catch (error) {
    throw normalizeRequestError(error, request.signal);
  } finally {
    request.cleanup();
  }
}
