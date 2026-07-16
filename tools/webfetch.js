const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

function stripTags(html) {
  let text = String(html);
  for (const tag of ["script", "style", "noscript", "svg", "nav", "footer", "header", "aside"]) {
    text = text.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), "");
  }
  text = text.replace(/<h([1-6])[^>]*>/gi, (_, level) => `\n${"#".repeat(Number(level))} `);
  text = text.replace(/<\/h[1-6]>/gi, "\n");
  text = text.replace(/<li[^>]*>/gi, "\n- ").replace(/<\/li>/gi, "");
  text = text.replace(/<(?:br|hr)\s*\/?>/gi, "\n");
  text = text.replace(/<\/(?:p|div|section|article|main|tr)>/gi, "\n");
  text = text.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, url, label) => {
    const clean = String(label).replace(/<[^>]+>/g, "").trim();
    return clean && clean !== url ? `${clean} [${url}]` : clean || url;
  });
  text = text.replace(/<[^>]+>/g, "");
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/gi, entity => ({
      "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
      "&apos;": "'", "&#39;": "'", "&nbsp;": " ",
    })[entity.toLowerCase()] || " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function extractText(html) {
  let skipDepth = 0;
  let text = "";
  const regex = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>|([^<]+)/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    if (match[3]) {
      if (skipDepth === 0) text += match[3];
    } else {
      const isClosing = Boolean(match[1]);
      const tag = match[2].toLowerCase();
      if (["script", "style", "noscript", "iframe", "object", "embed"].includes(tag)) {
        if (isClosing) skipDepth = Math.max(0, skipDepth - 1);
        else skipDepth++;
      } else if (!isClosing && skipDepth > 0) {
        skipDepth++;
      } else if (isClosing && skipDepth > 0) {
        skipDepth--;
      }
    }
  }
  return text.trim();
}

function buildAcceptHeader(format) {
  switch (format) {
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, */*;q=0.1";
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
    case "text":
    default:
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
  }
}

async function fetchUrl(url, format, timeoutSec) {
  const timeoutMs = Math.min(Math.max(1, timeoutSec || 30) * 1000, MAX_TIMEOUT_MS);
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: buildAcceptHeader(format),
    "Accept-Language": "en-US,en;q=0.9",
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal, redirect: "follow" });
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_RESPONSE_SIZE) {
      throw new Error(`Response too large (${Math.round(contentLength / 1024)} KB exceeds 5 MB limit)`);
    }
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_RESPONSE_SIZE) {
      throw new Error(`Response too large (${Math.round(buffer.byteLength / 1024)} KB exceeds 5 MB limit)`);
    }
    const body = new TextDecoder().decode(buffer);
    return { status: response.status, contentType, body, finalUrl: response.url || url };
  } finally {
    clearTimeout(timer);
  }
}

export const webfetchTool = {
  name: "webfetch",
  description: "Fetch content from a specified URL.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to fetch content from" },
      format: {
        type: "string",
        enum: ["text", "html", "markdown"],
        description: "The format to return the content in (text, markdown, or html). Defaults to markdown.",
        default: "markdown",
      },
      timeout: { type: "number", description: "Optional timeout in seconds (max 120)" },
    },
    required: ["url"],
  },
  async execute({ url, format = "markdown", timeout }) {
    if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
      return "Error: URL must start with http:// or https://";
    }
    const fmt = ["text", "html", "markdown"].includes(format) ? format : "markdown";
    try {
      const { status, contentType, body, finalUrl } = await fetchUrl(url, fmt, timeout);
      const title = `${finalUrl} (${contentType || "unknown"})`;
      let output;
      if (fmt === "html") {
        output = body;
      } else if (fmt === "markdown") {
        output = contentType.includes("text/html") ? stripTags(body) : body;
      } else {
        output = contentType.includes("text/html") ? extractText(body) : body;
      }
      const lines = [
        `URL: ${finalUrl}`,
        `Status: ${status}`,
        `Content-Type: ${contentType || "unknown"}`,
        `Bytes: ${Buffer.byteLength(body)}`,
        "",
        output,
      ];
      return lines.join("\n");
    } catch (error) {
      if (error.name === "AbortError") return "Error: request timed out";
      return `Error: ${error.message}`;
    }
  },
};
