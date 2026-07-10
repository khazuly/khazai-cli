const BASE = "https://aichat.org";

const SHORTCUTS = {
  gpt: "openai/gpt-4o-mini",
  claude: "anthropic/claude-haiku-4-5",
  gemini: "google/gemini-2.0-flash-001",
  deepseek: "deepseek/deepseek-chat-v3-0324",
  grok: "x-ai/grok-3-mini-beta",
  qwen: "qwen/qwen-2.5-72b-instruct",
};

function resolveModel(m) {
  return SHORTCUTS[m?.toLowerCase()] || m || SHORTCUTS.gpt;
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

export async function ensureSession() {
  if (_cookies.size > 0 && _csrf) return;

  const res = await fetch(`${BASE}/chat`, {
    headers: {
      "User-Agent": UA,
      Origin: BASE,
      Referer: `${BASE}/chat`,
    },
  });

  saveCookies(res);
  const html = await res.text();
  const m = html.match(/<meta name="csrf-token" content="([^"]+)"/);
  if (!m) throw new Error("Could not extract CSRF token");
  _csrf = m[1];
}

export async function chat(messages, opts = {}) {
  const model = resolveModel(opts.model);

  await ensureSession();

  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-TOKEN": _csrf,
      Accept: "text/event-stream",
      Cookie: cookieHeader(),
      Origin: BASE,
      Referer: `${BASE}/chat`,
      "User-Agent": UA,
    },
    body: JSON.stringify({ model, messages }),
  });

  if (res.status === 429) throw new Error("Rate limited (429)");
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${res.statusText}${body ? " - " + body.slice(0, 200) : ""}`);
  }

  // Save any new cookies from response
  saveCookies(res);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") continue;
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta?.content;
        if (delta) result += delta;
      } catch {}
    }
  }
  return result;
}
