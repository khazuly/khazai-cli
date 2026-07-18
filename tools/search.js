import { readdirSync, statSync, readFileSync } from "node:fs";
import { resolve, extname, join } from "node:path";
import { buildFindExclusions } from "../lib/ignore.js";
import { execAsync } from "../lib/exec-async.js";
import { requireWorkspace } from "./file.js";

export const globTool = {
  name: "glob",
  description: "Find files by glob pattern.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      ignore: { type: "array", items: { type: "string" }, description: "Extra patterns to exclude (e.g. *.log)" },
    },
    required: ["pattern"],
  },
  async execute({ pattern, path: dir, ignore = [], _agentWorkspace, _allowExternal }) {
    const cwd = dir ? resolve(process.cwd(), String(dir)) : process.cwd();
    requireWorkspace(cwd, _agentWorkspace, _allowExternal);
    try {
      const exclusions = buildFindExclusions(cwd, ignore);
      let nameArg;
      if (pattern.includes("**")) {
        const simplePattern = pattern.replace(/\*\*\//g, "").replace(/\*\*/g, "*");
        nameArg = `-name "${simplePattern}"`;
      } else {
        nameArg = `-name "${String(pattern)}"`;
      }
      const cmd = `cd "${cwd}" && find . -type f ${exclusions} ${nameArg} 2>/dev/null | head -300`;
      const { stdout } = await execAsync(cmd, { timeoutMs: 10000 });
      const files = stdout.split("\n").filter(Boolean).map(f => f.replace("./", ""));
      if (!files.length) return `No files matching "${pattern}" in ${cwd}`;
      return `Found ${files.length}:\n${files.join("\n")}`;
    } catch { return `Search failed for "${pattern}"`; }
  },
};

export const grepTool = {
  name: "grep",
  description: "Search file contents using regular expressions.",
  parameters: { type: "object", properties: { pattern: { type: "string" }, include: { type: "string" }, path: { type: "string" } }, required: ["pattern"] },
  async execute({ pattern, include, path: dir, _agentWorkspace, _allowExternal }) {
    const searchDir = dir ? resolve(process.cwd(), String(dir)) : process.cwd();
    requireWorkspace(searchDir, _agentWorkspace, _allowExternal);
    try {
      let cmd = `rg -n --no-heading "${String(pattern)}" "${searchDir}"`;
      if (include) cmd += ` -g "${String(include)}"`;
      cmd += " 2>/dev/null | head -200";
      const { stdout } = await execAsync(cmd, { timeoutMs: 15000 });
      if (!stdout) return `No matches for "${pattern}"`;
      return `Found ${stdout.split("\n").length}:\n${stdout}`;
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
