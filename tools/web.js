export const webTool = {
  name: "web",
  description: "Fetch a URL and return content as text.",
  parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  async execute({ url }) {
    try {
      const res = await fetch(String(url), {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; khazai-ai)" },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return `HTTP ${res.status}`;
      const text = await res.text();
      const s = text.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim();
      return s.length > 8000 ? s.slice(0, 8000) + `\n... (${s.length - 8000})` : s;
    } catch (err) { return `Error: ${err.message}`; }
  },
};
