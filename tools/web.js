const _pageCache = new Map();

function removeBlocks(text, tag) {
  const regex = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
  let prev;
  do { prev = text; text = text.replace(regex, ""); } while (text !== prev);
  return text;
}

function extractMeta(html) {
  const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || "";
  const desc = (html.match(/<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i) || [])[1]
    || (html.match(/<meta\s+[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i) || [])[1]
    || "";
  return { title: title.trim(), description: desc.trim() };
}

function extractLinks(html, baseUrl) {
  const links = [];
  const seen = new Set();
  const regex = /<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    let url = m[1].trim();
    const text = m[2].replace(/<[^>]+>/g, "").trim();
    if (!url || url.startsWith("javascript:") || url.startsWith("#") || url.startsWith("mailto:") || url.startsWith("tel:")) continue;
    try {
      url = new URL(url, baseUrl).href;
    } catch { continue; }
    if (seen.has(url)) continue;
    seen.add(url);
    links.push({ text: text || url, url });
  }
  return links;
}

function htmlToText(html) {
  let s = html;
  s = removeBlocks(s, "script"); s = removeBlocks(s, "style");
  s = removeBlocks(s, "noscript"); s = removeBlocks(s, "nav");
  s = removeBlocks(s, "footer"); s = removeBlocks(s, "header");
  s = removeBlocks(s, "aside");
  s = s.replace(/<pre><code([^>]*)>/gi, "\n```\n");
  s = s.replace(/<\/code><\/pre>/gi, "\n```\n");
  s = s.replace(/<code([^>]*)>/gi, "`"); s = s.replace(/<\/code>/gi, "`");
  s = s.replace(/<h1[^>]*>/gi, "\n# "); s = s.replace(/<h2[^>]*>/gi, "\n## ");
  s = s.replace(/<h3[^>]*>/gi, "\n### "); s = s.replace(/<h4[^>]*>/gi, "\n#### ");
  s = s.replace(/<h5[^>]*>/gi, "\n##### "); s = s.replace(/<h6[^>]*>/gi, "\n###### ");
  s = s.replace(/<\/h([1-6])>/gi, "\n");
  s = s.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, url, text) => {
    const t = text.replace(/<[^>]+>/g, "").trim();
    if (!t && !url) return ""; if (!t) return url;
    return t === url ? url : `${t} [${url}]`;
  });
  s = s.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*>/gi, (_, alt) => alt ? `[image: ${alt}]` : "");
  s = s.replace(/<img[^>]*>/gi, "");
  s = s.replace(/<li[^>]*>/gi, "\n- "); s = s.replace(/<\/li>/gi, "");
  s = s.replace(/<ol[^>]*>/gi, "\n"); s = s.replace(/<\/ol>/gi, "");
  s = s.replace(/<ul[^>]*>/gi, "\n"); s = s.replace(/<\/ul>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, "\n"); s = s.replace(/<p[^>]*>/gi, "\n");
  s = s.replace(/<\/p>/gi, "\n"); s = s.replace(/<div[^>]*>/gi, "\n");
  s = s.replace(/<\/div>/gi, "");
  s = s.replace(/<tr[^>]*>/gi, "\n"); s = s.replace(/<td[^>]*>/gi, "  ");
  s = s.replace(/<th[^>]*>/gi, "  "); s = s.replace(/<t[dh]>\/?/gi, "");
  s = s.replace(/<table[^>]*>/gi, "\n"); s = s.replace(/<\/table>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/&amp;/g, "&"); s = s.replace(/&lt;/g, "<");
  s = s.replace(/&gt;/g, ">"); s = s.replace(/&quot;/g, '"');
  s = s.replace(/&#39;/g, "'"); s = s.replace(/&#x27;/g, "'");
  s = s.replace(/&#x2F;/g, "/"); s = s.replace(/&#x3A;/g, ":");
  s = s.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)));
  s = s.replace(/&nbsp;/g, " "); s = s.replace(/&[a-zA-Z]+;/g, " ");
  s = s.replace(/\r\n/g, "\n"); s = s.replace(/\r/g, "\n");
  s = s.replace(/\n{4,}/g, "\n\n\n");
  s = s.replace(/[ \t]+\n/g, "\n"); s = s.replace(/\n[ \t]+/g, "\n");
  return s.trim();
}

function extractBySelector(html, selector) {
  const sel = selector.toLowerCase().trim();
  const regex = new RegExp(`<${sel}[^>]*>[\\s\\S]*?<\\/${sel}>`, "gi");
  const matches = html.match(regex);
  if (matches) return matches.join("\n");
  return html;
}

async function fetchAndCache(url, selector) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; khazai-ai; +https://github.com/khazuly/khazai-cli)" },
    signal: AbortSignal.timeout(20000),
    redirect: "follow",
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const snippet = body.replace(/<[^>]+>/g, "").trim().slice(0, 500);
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${snippet || "no response body"}`);
  }

  const contentType = res.headers.get("content-type") || "";
  const html = await res.text();
  const meta = extractMeta(html);
  const links = contentType.includes("text/html") ? extractLinks(html, url) : [];

  let text = html;
  if (selector) {
    const filtered = extractBySelector(text, selector);
    if (filtered !== text) text = filtered;
  }
  if (contentType.includes("text/html")) {
    text = htmlToText(text);
  }

  const cached = {
    title: meta.title,
    description: meta.description,
    text,
    links,
    totalChars: text.length,
  };
  _pageCache.set(url, cached);
  return cached;
}

export const webTool = {
  name: "web",
  description: "Fetch a URL and return structured text with pagination support. Use offset and limit to page through long content. Links from the page are listed so you can navigate to related documentation.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to fetch" },
      selector: { type: "string", description: "Optional HTML tag to extract only content inside that tag (e.g. 'main', 'article')" },
      offset: { type: "number", description: "Character offset to start reading from (default 0). Use to read the next chunk of a long page." },
      limit: { type: "number", description: "Max characters to return (default 15000). Reduce for smaller chunks." },
    },
    required: ["url"],
  },
  async execute({ url, selector, offset = 0, limit = 15000 }) {
    try {
      const cacheKey = `${url}::${selector || ""}`;
      if (!_pageCache.has(cacheKey)) {
        const cached = await fetchAndCache(url, selector);
        _pageCache.set(cacheKey, cached);
      }

      const { title, description, text, links, totalChars } = _pageCache.get(cacheKey);
      const end = Math.min(offset + limit, totalChars);
      const slice = text.slice(offset, end);

      const parts = [];
      if (title) parts.push(`Title: ${title}`);
      if (description) parts.push(`Description: ${description}`);
      parts.push(`Total ${totalChars} chars | showing ${offset}-${end} (${slice.length} chars)`);
      if (end < totalChars) {
        parts.push(`Continue: web url="${url}" offset=${end} limit=${limit}${selector ? ` selector="${selector}"` : ""}`);
      }
      parts.push("");
      parts.push(slice);

      if (links.length > 0) {
        const shown = links.slice(0, 20);
        parts.push("", `Links (${links.length} total, showing ${shown.length}):`);
        for (const l of shown) {
          parts.push(`- ${l.text}: ${l.url}`);
        }
        if (links.length > 20) {
          parts.push(`  ... and ${links.length - 20} more links. Use web tool to fetch them.`);
        }
      }

      return parts.join("\n");
    } catch (err) {
      if (err.message.startsWith("HTTP ")) return err.message;
      if (err.name === "TimeoutError") return "Error: request timed out after 20s";
      return `Error: ${err.message}`;
    }
  },
};
