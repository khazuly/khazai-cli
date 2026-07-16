const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 30;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_PAGE_CHARS = 2 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 30000;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const _pageCache = new Map();

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

function stripTags(text) {
  return decodeEntities(String(text).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function extractMeta(html) {
  const title = stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
  const description = stripTags(
    (html.match(/<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i) || [])[1]
      || (html.match(/<meta\s+[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i) || [])[1]
      || "",
  );
  return { title, description };
}

function extractLinks(html, baseUrl) {
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

function extractByTag(html, selector) {
  if (!selector) return null;
  if (!/^[a-z][a-z0-9-]*$/i.test(selector)) throw new Error("Selector must be a single HTML tag name");
  const regex = new RegExp(`<${selector}\\b[^>]*>[\\s\\S]*?<\\/${selector}>`, "gi");
  const matches = html.match(regex);
  return matches?.join("\n") || null;
}

function primaryContent(html) {
  for (const tag of ["main", "article"]) {
    const selected = extractByTag(html, tag);
    if (selected && stripTags(selected).length >= 200) return selected;
  }
  return html;
}

export function normalizeUrl(value) {
  let input = String(value || "").trim();
  if (!input || /\s/.test(input)) throw new Error("Invalid URL");
  if (input.startsWith("//")) input = `https:${input}`;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(input)) input = `https://${input}`;
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Invalid URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http:// and https:// URLs are supported");
  if (!url.hostname || (!url.hostname.includes(".") && url.hostname.toLowerCase() !== "localhost" && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname))) {
    throw new Error("Invalid URL");
  }
  if (url.username || url.password) throw new Error("Unsafe URL rejected");
  if (["169.254.169.254", "metadata.google.internal"].includes(url.hostname.toLowerCase())) {
    throw new Error("Restricted endpoint rejected");
  }
  url.hash = "";
  return url.href;
}

function protocolFallbackUrl(url) {
  const parsed = new URL(url);
  parsed.protocol = "http:";
  return parsed.href;
}

function shouldFallbackToHttp(error) {
  const detail = `${error?.name || ""} ${error?.message || ""} ${error?.cause?.code || ""}`;
  return /TypeError|TimeoutError|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|CERT|SSL|TLS|network/i.test(detail);
}

export function npmPackageFromUrl(value) {
  try {
    const url = new URL(String(value));
    if (!/(?:^|\.)npmjs\.com$/i.test(url.hostname)) return null;
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (segments[0] !== "package") return null;
    const packageName = segments[1]?.startsWith("@")
      ? `${segments[1]}/${segments[2] || ""}`
      : segments[1];
    if (!packageName || packageName.endsWith("/") || !/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(packageName)) return null;
    return packageName;
  } catch {
    return null;
  }
}

function normalizeRepositoryUrl(repository) {
  let value = typeof repository === "string" ? repository : repository?.url;
  if (!value) return null;
  value = String(value).trim().replace(/^git\+/, "");
  value = value
    .replace(/^git@github\.com:/i, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//i, "https://github.com/")
    .replace(/^git:\/\/github\.com\//i, "https://github.com/")
    .replace(/^github:/i, "https://github.com/")
    .replace(/\.git$/i, "");
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function githubRepositoryFromUrl(value) {
  try {
    const url = new URL(String(value));
    if (!/(?:^|\.)github\.com$/i.test(url.hostname)) return null;
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 2 || !segments.every(segment => /^[a-z0-9_.-]+$/i.test(segment))) return null;
    return { owner: segments[0], repo: segments[1].replace(/\.git$/i, "") };
  } catch {
    return null;
  }
}

async function readLimited(response, limit = MAX_RESPONSE_BYTES) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > limit) throw new Error(`Response exceeds ${Math.round(limit / 1024)} KB limit`);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let bytes = 0;
  let complete = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) { complete = true; break; }
      bytes += value.byteLength;
      if (bytes > limit) throw new Error(`Response exceeds ${Math.round(limit / 1024)} KB limit`);
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function requestPage(url, maxBytes = MAX_RESPONSE_BYTES, extraHeaders = {}) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/json,text/plain,application/xhtml+xml,*/*", ...extraHeaders },
        signal: AbortSignal.timeout(20000),
        redirect: "follow",
      });
      if ((response.status === 429 || response.status >= 500) && attempt === 0) {
        await new Promise(resolve => setTimeout(resolve, 300));
        continue;
      }
      if (!response.ok) {
        const body = await readLimited(response, maxBytes).catch(() => "");
        throw new Error(`HTTP ${response.status} ${response.statusText} — ${stripTags(body).slice(0, 300) || "no response body"}`);
      }
      return { response, body: await readLimited(response, maxBytes) };
    } catch (error) {
      lastError = error;
      if (attempt === 0 && (error.name === "TimeoutError" || error.name === "TypeError")) continue;
      break;
    }
  }
  if (lastError?.cause?.code) {
    const host = lastError.cause.hostname || new URL(url).hostname;
    throw new Error(`${lastError.cause.code} while connecting to ${host}`);
  }
  throw lastError || new Error("Request failed");
}

async function requestPageWithProtocolFallback(url, maxBytes = MAX_RESPONSE_BYTES, extraHeaders = {}) {
  try {
    return { ...(await requestPage(url, maxBytes, extraHeaders)), requestedUrl: url };
  } catch (error) {
    if (!url.startsWith("https://") || !shouldFallbackToHttp(error)) throw error;
    const fallbackUrl = protocolFallbackUrl(url);
    return { ...(await requestPage(fallbackUrl, maxBytes, extraHeaders)), requestedUrl: fallbackUrl };
  }
}

async function fetchGithubReadmePage(originalUrl, repository) {
  const readmeUrl = `https://raw.githubusercontent.com/${repository.owner}/${repository.repo}/HEAD/README.md`;
  const { response, body } = await requestPage(readmeUrl);
  const readme = body.trim();
  const text = `Source: GitHub README fallback\nREADME: ${response.url || readmeUrl}\n\n${readme}`;
  return {
    title: `${repository.owner}/${repository.repo} README`,
    description: `README fallback for ${repository.owner}/${repository.repo}`,
    text,
    links: [
      { text: "Repository", url: originalUrl },
      { text: "README", url: response.url || readmeUrl },
    ],
    finalUrl: originalUrl,
    contentType: (response.headers.get("content-type") || "text/markdown").toLowerCase(),
    totalChars: text.length,
    responseBytes: Buffer.byteLength(body),
  };
}

async function fetchNpmPackagePage(originalUrl, packageName) {
  const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`;
  const { response, body } = await requestPage(registryUrl);
  let metadata;
  try {
    metadata = JSON.parse(body);
  } catch {
    throw new Error(`npm registry returned invalid JSON for ${packageName}`);
  }

  const repositoryUrl = normalizeRepositoryUrl(metadata.repository);
  const githubRepository = repositoryUrl ? githubRepositoryFromUrl(repositoryUrl) : null;
  let readme = String(metadata.readme || "").trim();
  let readmeUrl = null;
  let readmeError = null;
  if (!readme && githubRepository) {
    try {
      const page = await fetchGithubReadmePage(repositoryUrl, githubRepository);
      readme = page.text.replace(/^Source: GitHub README fallback\nREADME: [^\n]+\n\n/, "");
      readmeUrl = page.links.find(link => link.text === "README")?.url || null;
    } catch (error) {
      readmeError = error.message;
    }
  }

  const lines = [
    `# ${metadata.name || packageName}`,
    "",
    metadata.description || "No package description provided.",
    "",
    `Version: ${metadata.version || "unknown"}`,
    `Install: npm install ${metadata.name || packageName}`,
    ...(metadata.license ? [`License: ${metadata.license}`] : []),
    ...(metadata.engines?.node ? [`Node: ${metadata.engines.node}`] : []),
    ...(metadata.main ? [`Main: ${metadata.main}`] : []),
    ...(metadata.types || metadata.typings ? [`Types: ${metadata.types || metadata.typings}`] : []),
    ...(repositoryUrl ? [`Repository: ${repositoryUrl}`] : []),
    ...(metadata.homepage ? [`Homepage: ${metadata.homepage}`] : []),
    `Registry: ${response.url || registryUrl}`,
    ...(metadata.dist?.tarball ? [`Tarball: ${metadata.dist.tarball}`] : []),
    "",
    readme ? "## README" : "README: unavailable",
    ...(readme ? ["", readme] : []),
    ...(readmeError ? [`README fallback failed: ${readmeError}`] : []),
  ];
  let text = lines.join("\n").trim();
  if (text.length > MAX_PAGE_CHARS) text = text.slice(0, MAX_PAGE_CHARS) + "\n[Page truncated at 2 MB of text]";
  const links = [
    { text: "npm package", url: originalUrl },
    { text: "npm registry", url: response.url || registryUrl },
    ...(repositoryUrl ? [{ text: "Repository", url: repositoryUrl }] : []),
    ...(metadata.homepage ? [{ text: "Homepage", url: metadata.homepage }] : []),
    ...(readmeUrl ? [{ text: "README", url: readmeUrl }] : []),
  ];
  return {
    title: `${metadata.name || packageName} - npm`,
    description: metadata.description || "",
    text,
    links,
    finalUrl: originalUrl,
    contentType: "application/json",
    totalChars: text.length,
    responseBytes: Buffer.byteLength(body),
  };
}

function getCached(key) {
  const entry = _pageCache.get(key);
  if (!entry || Date.now() - entry.createdAt > CACHE_TTL_MS) {
    _pageCache.delete(key);
    return null;
  }
  _pageCache.delete(key);
  _pageCache.set(key, entry);
  return entry.page;
}

function remember(key, page) {
  _pageCache.set(key, { createdAt: Date.now(), page });
  while (_pageCache.size > MAX_CACHE_ENTRIES) _pageCache.delete(_pageCache.keys().next().value);
}

async function fetchPage(url, selector) {
  const npmPackage = npmPackageFromUrl(url);
  if (npmPackage) return fetchNpmPackagePage(url, npmPackage);

  let response;
  let body;
  let requestedUrl = url;
  try {
    ({ response, body, requestedUrl } = await requestPageWithProtocolFallback(url));
  } catch (error) {
    const githubRepository = githubRepositoryFromUrl(url);
    if (githubRepository) return fetchGithubReadmePage(url, githubRepository);
    throw error;
  }
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  const finalUrl = response.url || requestedUrl || url;
  let title = "";
  let description = "";
  let text;
  let links = [];

  if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) {
    ({ title, description } = extractMeta(body));
    links = extractLinks(body, finalUrl);
    const selected = selector ? extractByTag(body, selector) : primaryContent(body);
    if (selector && !selected) throw new Error(`Selector <${selector}> was not found`);
    text = htmlToText(selected || body);
  } else if (contentType.includes("application/json")) {
    try { text = JSON.stringify(JSON.parse(body), null, 2); }
    catch { text = body.trim(); }
  } else if (contentType.startsWith("text/") || contentType.includes("xml")) {
    text = contentType.includes("xml") ? htmlToText(body) : body.trim();
  } else {
    throw new Error(`Unsupported content type: ${contentType || "unknown"}`);
  }

  if (text.length > MAX_PAGE_CHARS) text = text.slice(0, MAX_PAGE_CHARS) + "\n[Page truncated at 2 MB of text]";
  return { title, description, text, links, finalUrl, contentType, totalChars: text.length, responseBytes: Buffer.byteLength(body) };
}

export const webTool = {
  name: "web",
  description: "Fetch an HTTP(S) URL and return its content.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The HTTP(S) URL to fetch" },
      selector: { type: "string", description: "Optional HTML tag to extract, such as main or article" },
      offset: { type: "number", description: "Character offset for pagination (default 0)" },
      limit: { type: "number", description: "Characters to return (default 15000, max 30000)" },
    },
    required: ["url"],
  },
  async execute({ url, selector, offset = 0, limit = 15000 }) {
    try {
      const normalizedUrl = normalizeUrl(url);
      const normalizedSelector = selector ? String(selector).trim().toLowerCase() : "";
      if (normalizedSelector && !/^[a-z][a-z0-9-]*$/i.test(normalizedSelector)) {
        return "Error: selector must be a single HTML tag name";
      }
      const start = Math.max(0, Math.trunc(Number(offset) || 0));
      const pageSize = Math.min(Math.max(1, Math.trunc(Number(limit) || 15000)), MAX_OUTPUT_CHARS);
      const cacheKey = `${normalizedUrl}::${normalizedSelector}`;
      let page = getCached(cacheKey);
      const fromCache = Boolean(page);
      if (!page) {
        page = await fetchPage(normalizedUrl, normalizedSelector);
        remember(cacheKey, page);
      }
      if (start >= page.totalChars && page.totalChars > 0) {
        return `Error: offset ${start} is beyond page length ${page.totalChars}`;
      }
      const end = Math.min(start + pageSize, page.totalChars);
      const parts = [];
      if (page.title) parts.push(`Title: ${page.title}`);
      if (page.description) parts.push(`Description: ${page.description}`);
      parts.push(`URL: ${page.finalUrl}`);
      parts.push(`Content-Type: ${page.contentType.split(";")[0] || "unknown"}${fromCache ? " | cached" : ""}`);
      parts.push(`Bytes: ${page.responseBytes}`);
      parts.push(`Total ${page.totalChars} chars | showing ${start}-${end}`);
      if (end < page.totalChars) {
        parts.push(`Continue: web url="${normalizedUrl}" offset=${end} limit=${pageSize}${normalizedSelector ? ` selector="${normalizedSelector}"` : ""}`);
      }
      parts.push("", page.text.slice(start, end));
      if (start === 0 && page.links.length) {
        const shown = page.links.slice(0, 25);
        parts.push("", `Links (${page.links.length} total, showing ${shown.length}):`);
        for (const link of shown) parts.push(`- ${link.text}: ${link.url}`);
      }
      return parts.join("\n");
    } catch (error) {
      if (error.name === "TimeoutError") return "Error: request timed out after 20s";
      return `Error: ${error.message}`;
    }
  },
};
