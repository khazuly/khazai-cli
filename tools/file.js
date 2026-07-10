import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, extname, dirname, relative } from "node:path";
import { getWorkspace } from "../config/workspace.js";

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

const IMG = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"]);

function requireWorkspace(path) {
  const ws = getWorkspace();
  if (!ws.trusted) return;
  const abs = resolve(process.cwd(), String(path));
  const rel = relative(ws.path, abs);
  if (rel.startsWith("..")) {
    throw new Error(`Access denied: ${abs} is outside workspace ${ws.path}`);
  }
}

export const readTool = {
  name: "read",
  description: "Read file contents with line numbers.",
  parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["path"] },
  async execute({ path, offset = 1, limit = 2000 }) {
    const abs = resolve(process.cwd(), String(path));
    if (!existsSync(abs)) return `Error: not found: ${path}`;
    if (IMG.has(extname(abs).toLowerCase())) {
      const data = readFileSync(abs);
      return `data:image/${extname(abs).slice(1)};base64,${data.toString("base64")}`;
    }
    const content = readFileSync(abs, "utf-8");
    const lines = content.split("\n");
    const start = Math.max(0, Number(offset) - 1);
    const end = Math.min(start + Number(limit), lines.length);
    const slice = lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join("\n");
    return `File: ${path}\nLines: ${lines.length}\n${start + 1}-${end}\n\n${slice}`;
  },
};

export const writeTool = {
  name: "write",
  description: "Write content to a file.",
  parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  async execute({ path, content }) {
    requireWorkspace(path);
    const abs = resolve(process.cwd(), String(path));
    mkdirSync(dirname(abs), { recursive: true });
    const existing = existsSync(abs) ? readFileSync(abs, "utf-8") : null;
    if (existing === String(content)) return `No changes to ${path}`;
    writeFileSync(abs, String(content), "utf-8");
    return `Written ${String(content).length} bytes to ${path}`;
  },
};

const EDITORS = [
  { name: "exact", apply: (c, o, n) => { const i = c.indexOf(o); return i < 0 ? null : c.slice(0, i) + n + c.slice(i + o.length); }},
  { name: "trimmed", apply: (c, o, n) => { const i = c.indexOf(o.trim()); return i < 0 ? null : c.slice(0, i) + n.trim() + c.slice(i + o.trim().length); }},
  { name: "fuzzy", apply: (c, o, n) => {
    const cl = c.split("\n"), ol = o.split("\n"), th = Math.max(3, Math.floor(o.length * 0.3));
    for (let i = 0; i <= cl.length - ol.length; i++) {
      let d = 0;
      for (let j = 0; j < ol.length; j++) d += levenshtein(cl[i + j].trim(), ol[j].trim());
      if (d <= th) return cl.slice(0, i).join("\n") + (i > 0 ? "\n" : "") + n + cl.slice(i + ol.length).join("\n");
    }
    return null;
  }},
];

export const editTool = {
  name: "edit",
  description: "Edit a file by replacing text (exact, trimmed, or fuzzy).",
  parameters: { type: "object", properties: { path: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" } }, required: ["path", "oldString", "newString"] },
  async execute({ path, oldString, newString }) {
    requireWorkspace(path);
    const abs = resolve(process.cwd(), String(path));
    if (!existsSync(abs)) return `Error: not found: ${path}`;
    const orig = readFileSync(abs, "utf-8");
    for (const e of EDITORS) {
      const r = e.apply(orig, String(oldString), String(newString));
      if (r !== null) { writeFileSync(abs, r, "utf-8"); return `Edited ${path} (${e.name})`; }
    }
    return `Error: text not found in ${path}`;
  },
};
