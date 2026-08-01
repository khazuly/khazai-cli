function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/gi, entity => ({
      "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
      "&apos;": "'", "&#39;": "'", "&nbsp;": " ",
    })[entity.toLowerCase()] || " ");
}

function removeBlocks(text, tag) {
  const regex = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
  let previous;
  do {
    previous = text;
    text = text.replace(regex, "");
  } while (text !== previous);
  return text;
}

export function stripTags(text) {
  return decodeEntities(String(text).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

export function extractMeta(html) {
  const title = stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
  const description = stripTags(
    (html.match(/<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i) || [])[1]
      || (html.match(/<meta\s+[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i) || [])[1]
      || "",
  );
  return { title, description };
}

export function extractLinks(html, baseUrl) {
  const links = [];
  const seen = new Set();
  const regex = /<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const raw = decodeEntities(match[1]).trim();
    const text = stripTags(match[2]);
    if (!raw || /^(?:javascript:|mailto:|tel:|#)/i.test(raw)) continue;
    try {
      const url = new URL(raw, baseUrl);
      if (!["http:", "https:"].includes(url.protocol)) continue;
      url.hash = "";
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      links.push({ text: text || url.href, url: url.href });
    } catch {}
  }
  return links;
}

export function htmlToText(html) {
  let text = String(html);
  for (const tag of ["script", "style", "noscript", "svg", "nav", "footer", "header", "aside", "form"]) {
    text = removeBlocks(text, tag);
  }
  text = text.replace(/<pre[^>]*>\s*<code[^>]*class=["'][^"']*language-([^"' ]+)[^"']*["'][^>]*>/gi, "\n```$1\n");
  text = text.replace(/<pre[^>]*>\s*<code[^>]*>/gi, "\n```\n");
  text = text.replace(/<\/code>\s*<\/pre>/gi, "\n```\n");
  text = text.replace(/<code[^>]*>/gi, "`").replace(/<\/code>/gi, "`");
  text = text.replace(/<h([1-6])[^>]*>/gi, (_, level) => `\n${"#".repeat(Number(level))} `);
  text = text.replace(/<\/h[1-6]>/gi, "\n");
  text = text.replace(/<li[^>]*>/gi, "\n- ").replace(/<\/li>/gi, "");
  text = text.replace(/<(?:br|hr)\s*\/?>/gi, "\n");
  text = text.replace(/<\/(?:p|div|section|article|main|tr|table|ul|ol)>/gi, "\n");
  text = text.replace(/<(?:p|div|section|article|main|table|ul|ol)[^>]*>/gi, "\n");
  text = text.replace(/<t[dh][^>]*>/gi, "  ").replace(/<\/t[dh]>/gi, "");
  text = text.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, url, label) => {
    const clean = stripTags(label);
    return clean && clean !== url ? `${clean} [${decodeEntities(url)}]` : clean || decodeEntities(url);
  });
  text = text.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*>/gi, (_, alt) => alt ? `[image: ${decodeEntities(alt)}]` : "");
  text = text.replace(/<[^>]+>/g, "");
  text = decodeEntities(text).replace(/\r\n?/g, "\n");
  text = text.replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n");
  text = text.replace(/\n{4,}/g, "\n\n\n");
  return text.trim();
}

export function extractByTag(html, selector) {
  if (!selector) return null;
  if (!/^[a-z][a-z0-9-]*$/i.test(selector)) throw new Error("Selector must be a single HTML tag name");
  const regex = new RegExp(`<${selector}\\b[^>]*>[\\s\\S]*?<\\/${selector}>`, "gi");
  const matches = html.match(regex);
  return matches?.join("\n") || null;
}

export function primaryContent(html) {
  for (const tag of ["main", "article"]) {
    const selected = extractByTag(html, tag);
    if (selected && stripTags(selected).length >= 200) return selected;
  }
  return html;
}

