function stripTags(s) {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").trim();
}

function extractResults(html) {
  const results = [];

  const resultRegex = /<div[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div|<ol)/gi;
  let match;

  while ((match = resultRegex.exec(html)) !== null) {
    const block = match[1];

    const titleMatch = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    const snippetMatch = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    const urlMatch = /<span[^>]*class="[^"]*result__url[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(block);

    const title = titleMatch ? stripTags(titleMatch[1]) : "";
    const snippet = snippetMatch ? stripTags(snippetMatch[1]) : "";
    const url = urlMatch ? stripTags(urlMatch[1]) : "";

    if (title && url) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

export const webSearchTool = {
  name: "websearch",
  description: "Search the web for a query and return relevant results (title, URL, snippet). Uses DuckDuckGo, no API key required. Then use the web tool to fetch full page content.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query" },
      count: { type: "number", description: "Number of results to return (1-10, default 5)" },
    },
    required: ["query"],
  },
  async execute({ query, count = 5 }) {
    try {
      const res = await fetch("https://html.duckduckgo.com/html/", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Mozilla/5.0 (compatible; khazai-ai; +https://github.com/khazuly/khazai-cli)",
        },
        body: new URLSearchParams({ q: String(query) }),
        signal: AbortSignal.timeout(15000),
        redirect: "follow",
      });

      if (!res.ok) return `Search failed: HTTP ${res.status}`;

      const html = await res.text();
      const results = extractResults(html);
      const n = Math.min(Math.max(1, Number(count) || 5), 10);
      const top = results.slice(0, n);

      if (top.length === 0) return "No results found.";

      return top.map((r, i) =>
        `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`
      ).join("\n\n");
    } catch (err) {
      if (err.name === "TimeoutError") return "Error: search request timed out";
      return `Error: ${err.message}`;
    }
  },
};
