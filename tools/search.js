import { execSync } from "node:child_process";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { resolve, extname, join } from "node:path";
import { buildFindExclusions } from "../lib/ignore.js";

export const globTool = {
  name: "glob",
  description: "Find files matching a glob pattern. Excludes node_modules, .git, build artifacts, and patterns from .gitignore by default.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      ignore: { type: "array", items: { type: "string" }, description: "Extra patterns to exclude (e.g. *.log)" },
    },
    required: ["pattern"],
  },
  async execute({ pattern, path: dir, ignore = [] }) {
    const cwd = dir ? resolve(process.cwd(), String(dir)) : process.cwd();
    try {
      const exclusions = buildFindExclusions(cwd, ignore);
      const cmd = `find "${cwd}" -type f ${exclusions} -name "${String(pattern)}" 2>/dev/null | head -300`;
      const out = execSync(cmd, { encoding: "utf-8", timeout: 10000 });
      const files = out.trim().split("\n").filter(Boolean).map(f => f.replace(cwd + "/", "").replace(cwd, "."));
      if (!files.length) return `No files matching "${pattern}"`;
      return `Found ${files.length}:\n${files.join("\n")}`;
    } catch { return `Search failed for "${pattern}"`; }
  },
};

export const grepTool = {
  name: "grep",
  description: "Search file contents with regex.",
  parameters: { type: "object", properties: { pattern: { type: "string" }, include: { type: "string" }, path: { type: "string" } }, required: ["pattern"] },
  async execute({ pattern, include, path: dir }) {
    const searchDir = dir ? resolve(process.cwd(), String(dir)) : process.cwd();
    try {
      let cmd = `rg -n --no-heading "${String(pattern)}" "${searchDir}"`;
      if (include) cmd += ` -g "${String(include)}"`;
      const out = execSync(cmd + " 2>/dev/null | head -200", { encoding: "utf-8", timeout: 15000 });
      if (!out.trim()) return `No matches for "${pattern}"`;
      return `Found ${out.trim().split("\n").length}:\n${out.trim()}`;
    } catch {
      const results = [];
      const walk = (d) => {
        for (const e of readdirSync(d)) {
          const p = join(d, e);
          if (e.startsWith(".") || e === "node_modules") continue;
          if (statSync(p).isDirectory()) { walk(p); continue; }
          if (include) {
            const ext = extname(p);
            if (!String(include).split(",").some(g => g.trim().replace("*", "") === ext)) continue;
          }
          const content = readFileSync(p, "utf-8");
          for (let i = 0; i < content.split("\n").length; i++) {
            const line = content.split("\n")[i];
            if (line.toLowerCase().includes(String(pattern).toLowerCase())) {
              results.push(`${p}:${i + 1}: ${line.trim()}`);
              if (results.length >= 200) return;
            }
          }
        }
      };
      walk(searchDir);
      if (!results.length) return `No matches for "${pattern}"`;
      return `Found ${results.length} (basic):\n${results.join("\n")}`;
    }
  },
};
