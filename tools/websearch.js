const SEARCH_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 50;
const MAX_SEARCH_BODY = 2 * 1024 * 1024;
const USER_AGENT = "Mozilla/5.0 (compatible; khazai-ai; +https://github.com/khazuly/khazai-cli)";
const _searchCache = new Map();

function decodeHtml(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/gi, entity => ({
      "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
      "&apos;": "'", "&#39;": "'", "&nbsp;": " ",
    })[entity.toLowerCase()] || " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeResultUrl(raw) {
  try {
    const url = new URL(decodeHtml(raw), "https://html.duckduckgo.com");
    const redirected = url.searchParams.get("uddg");
    let target = redirected ? new URL(redirected) : url;
    if (/(?:^|\.)bing\.com$/i.test(url.hostname) && url.pathname.startsWith("/ck/")) {
      const encoded = url.searchParams.get("u") || "";
      if (encoded.startsWith("a1")) {
        const decoded = Buffer.from(encoded.slice(2), "base64url").toString("utf8");
        target = new URL(decoded);
      }
    }
    if (!["http:", "https:"].includes(target.protocol)) return null;
    target.hash = "";
    return target.href;
  } catch {
    return null;
  }
}

export function extractSearchResults(html) {
  const anchors = [...String(html).matchAll(
    /<a\b([^>]*class=["'][^"']*(?:result__a|result-link)[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi,
  )];
  const results = [];
  const seen = new Set();

  for (let index = 0; index < anchors.length; index++) {
    const match = anchors[index];
    const href = /href=["']([^"']+)["']/i.exec(match[1])?.[1];
    const url = normalizeResultUrl(href);
    const title = decodeHtml(match[2]);
    if (!url || !title || seen.has(url)) continue;

    const blockEnd = anchors[index + 1]?.index ?? html.length;
    const following = html.slice((match.index || 0) + match[0].length, blockEnd);
    const snippetMatch = /<(?:a|div|td)[^>]*class=["'][^"']*(?:result__snippet|result-snippet)[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|td)>/i.exec(following);
    const snippet = decodeHtml(snippetMatch?.[1] || "");
    seen.add(url);
    results.push({ title, url, snippet, domain: new URL(url).hostname.replace(/^www\./, "") });
  }
  return results;
}

export function extractBingResults(html) {
  const results = [];
  const seen = new Set();
  const blocks = String(html).match(/<li\b[^>]*class=["'][^"']*b_algo[^"']*["'][^>]*>[\s\S]*?<\/li>/gi) || [];
  for (const block of blocks) {
    const anchor = /<h2[^>]*>\s*<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(block);
    const url = normalizeResultUrl(anchor?.[1]);
    const title = decodeHtml(anchor?.[2] || "");
    if (!url || !title || seen.has(url)) continue;
    const snippet = decodeHtml(/<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1] || "");
    seen.add(url);
    results.push({ title, url, snippet, domain: new URL(url).hostname.replace(/^www\./, "") });
  }
  return results;
}

async function readLimited(response, limit) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  let complete = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) { complete = true; break; }
      size += value.byteLength;
      if (size > limit) throw new Error(`Search response exceeded ${Math.round(limit / 1024)} KB`);
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function cached(query) {
  const entry = _searchCache.get(query);
  if (!entry || Date.now() - entry.createdAt > SEARCH_TTL_MS) {
    _searchCache.delete(query);
    return null;
  }
  _searchCache.delete(query);
  _searchCache.set(query, entry);
  return entry.results;
}

function remember(query, results) {
  _searchCache.set(query, { createdAt: Date.now(), results });
  while (_searchCache.size > MAX_CACHE_ENTRIES) _searchCache.delete(_searchCache.keys().next().value);
}

function requestedDomain(query) {
  const match = /(?:https?:\/\/)?(?:www\.)?([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,})(?:\b|\/)/i.exec(query);
  return match?.[1]?.toLowerCase() || null;
}

function filterForDomain(results, domain) {
  if (!domain) return results;
  return results.filter(result => {
    const host = result.domain.toLowerCase();
    const searchable = `${result.title} ${result.snippet}`.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`) || searchable.includes(domain);
  });
}

async function search(query) {
  const attempts = [
    { url: "https://html.duckduckgo.com/html/", method: "POST", body: new URLSearchParams({ q: query }), parser: extractSearchResults },
    { url: `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, method: "GET", parser: extractSearchResults },
    { url: `https://www.bing.com/search?q=${encodeURIComponent(query)}`, method: "GET", parser: extractBingResults },
  ];
  let lastError;
  let providerResponded = false;
  for (const attempt of attempts) {
    try {
      const response = await fetch(attempt.url, {
        method: attempt.method,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
          ...(attempt.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        body: attempt.body,
        signal: AbortSignal.timeout(15000),
        redirect: "follow",
      });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
        continue;
      }
      providerResponded = true;
      const results = attempt.parser(await readLimited(response, MAX_SEARCH_BODY));
      if (results.length) return results;
      lastError = new Error("Search provider returned no parseable results");
    } catch (error) {
      lastError = error;
    }
  }
  if (providerResponded) return [];
  throw lastError || new Error("Search failed");
}

export const webSearchTool = {
  name: "websearch",
  description: "Search the web and return normalized result titles, direct URLs, domains, and snippets.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query" },
      count: { type: "number", description: "Number of results to return (1-10, default 5)" },
    },
    required: ["query"],
  },
  async execute({ query, count = 5 }) {
    const normalizedQuery = String(query || "").trim().replace(/\s+/g, " ");
    if (!normalizedQuery) return "Error: search query cannot be empty";
    if (normalizedQuery.length > 500) return "Error: search query exceeds 500 characters";
    const limit = Math.min(Math.max(1, Math.trunc(Number(count) || 5)), 10);
    try {
      let results = cached(normalizedQuery);
      const fromCache = Boolean(results);
      if (!results) {
        results = await search(normalizedQuery);
        remember(normalizedQuery, results);
      }
      const domain = requestedDomain(normalizedQuery);
      let relevant = filterForDomain(results, domain);
      if (domain && relevant.length === 0 && normalizedQuery.toLowerCase() !== domain) {
        let fallbackResults = cached(domain);
        if (!fallbackResults) {
          fallbackResults = await search(domain);
          remember(domain, fallbackResults);
        }
        const merged = [...results];
        const seen = new Set(merged.map(result => result.url));
        for (const result of fallbackResults) {
          if (!seen.has(result.url)) merged.push(result);
        }
        relevant = filterForDomain(merged, domain);
      }
      if (domain && relevant.length === 0) {
        return `No relevant results found for domain ${domain}. The search providers returned only unrelated pages.`;
      }
      const top = relevant.slice(0, limit);
      const lines = [`Search results for: ${normalizedQuery}`, `Found ${relevant.length}${fromCache ? " (cached)" : ""}; showing ${top.length}`, ""];
      for (const [index, result] of top.entries()) {
        lines.push(`${index + 1}. ${result.title}`);
        lines.push(`   URL: ${result.url}`);
        lines.push(`   Source: ${result.domain}`);
        if (result.snippet) lines.push(`   ${result.snippet}`);
        lines.push("");
      }
      return lines.join("\n").trimEnd();
    } catch (error) {
      if (error.name === "TimeoutError") return "Error: web search timed out after 15s";
      return `Error: ${error.message}`;
    }
  },
};
