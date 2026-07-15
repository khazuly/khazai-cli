import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { execAsync } from "../lib/exec-async.js";

const CMD_FIXES = [
  { from: /python3?\s+-m\s+ht\b(?!\.server)/g, to: "python3 -m http.server" },
  { from: /python3?\s+-m\s+http\s+server/g, to: "python3 -m http.server" },
  { from: /python3?\s+-m\s+SimpleHTTPServer/g, to: "python3 -m http.server" },
];

function fixCommand(cmd) {
  let fixed = cmd;
  for (const { from, to } of CMD_FIXES) {
    if (from.test(fixed)) {
      fixed = fixed.replace(from, to);
    }
  }
  return fixed;
}

const SERVER_CMDS = /^node\s+(?!.*--check)(?!.*-e\s)|^python[3]?\s+.*http\.server|^python[3]?\s+.*SimpleHTTP|^npm\s+start|^yarn\s+start|^pm2\s+|^forever\s+|^nodemon\s+/i;
const WRITE_VIA_BASH = /^cat\s*>|^tee\s+|^echo\s+['"]*>|^printf\s+/i;
// `find ... | head -20` and `rg ... | head` only limit generated output; they
// do not inspect file contents. Keep blocking actual file readers at the start
// of a command (or after a command separator), but allow head/tail as a pipe
// consumer. `cat` and pagers remain blocked anywhere in a command chain.
const DIRECT_FILE_READER = /(?:^|[;&]\s*)\s*(?:head|tail)\b/i;
const FILE_READER_ANYWHERE = /(?:^|[;&|]\s*)\s*(?:cat|less|more)\b/i;
const WEB_VIA_BASH = /(?:^|[;&|]\s*)\s*(?:curl|wget)\b/i;
const SCRIPT_EXTENSIONS = new Set([".py", ".pyw", ".js", ".mjs", ".cjs", ".sh", ".bash", ".zsh"]);

function requestedScript(command) {
  // Match interpreter invocations even after a harmless `cd ... &&` prefix.
  // Flags such as `-m`, `-c`, and `-e` are intentionally excluded: they do
  // not name a local script that must exist first.
  const match = /(?:^|[;&|]\s*)\s*(?:python(?:3)?|node)\s+(?!-(?:m|c|e)\b)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/i.exec(command);
  const script = (match?.[1] || match?.[2] || match?.[3] || "").trim();
  if (!script) return null;
  const lower = script.toLowerCase();
  return [...SCRIPT_EXTENSIONS].some(ext => lower.endsWith(ext)) ? script : null;
}

function redirect(proposedAction, recommendedAction, guidance) {
  return { needsSteering: true, detectedIntent: "EXECUTION", proposedAction, recommendedAction, guidance };
}

export const bashTool = {
  name: "bash",
  description: "Execute a shell command (timeout in seconds). Retries up to 2 times on timeout with doubled timeout.",
  parameters: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number", description: "timeout in seconds" }, workdir: { type: "string" } }, required: ["command"] },
  async execute({ command, timeout = 60, workdir }) {
    const cwd = workdir ? resolve(process.cwd(), String(workdir)) : process.cwd();
    const fixed = fixCommand(command);

    if (SERVER_CMDS.test(fixed) || /&\s*$/.test(fixed.trim())) {
      return redirect("start a long-running server", "prepare files and report the command", "Do not start a foreground server. Complete the requested implementation and let the user run it locally.");
    }

    if (WRITE_VIA_BASH.test(fixed)) {
      return redirect("write through shell redirection", "write or edit tool", "Use the file tool so the change is validated and tracked.");
    }

    if (DIRECT_FILE_READER.test(fixed) || FILE_READER_ANYWHERE.test(fixed)) {
      return redirect("read file through shell", "read tool", "Use the read tool for file contents, then continue the current task.");
    }

    if (WEB_VIA_BASH.test(fixed)) {
      return redirect("network request through shell", "web or websearch tool", "Use the web tool for network access and preserve the current task state.");
    }

    const script = requestedScript(fixed);
    if (script && !existsSync(resolve(cwd, script))) {
      return redirect("run a missing script", "write the requested script", "Create the missing script with the file tool before running validation.");
    }

    const isLongRunning = /node\s+server|python.*http\.server|python.*SimpleHTTP|npm\s+start|yarn\s+start|pm2\s+|forever\s+|nodemon\s+/i.test(fixed);
    let lastErr = null;
    let attempts = 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      attempts = attempt;
      const t = (attempt === 1 ? Number(timeout) : Number(timeout) * (attempt === 2 ? 2 : 4)) * 1000;
      try {
        const { stdout: out } = await execAsync(fixed, { cwd, timeoutMs: t });
        const prefix = attempt > 1 ? `(retry #${attempt - 1}) ` : "";
        return `${prefix}Exit: 0\n${out.slice(0, 5000)}${out.length > 5000 ? `\n... (${out.length - 5000} more)` : ""}`;
      } catch (err) {
        lastErr = err;
        if (!err.killed) break;
        if (isLongRunning) break;
      }
    }
    const stderr = lastErr.stderr?.trim() ?? "";
    const stdout = lastErr.stdout?.trim() ?? "";
    const code = lastErr.status ?? -1;
    // grep/rg reserve status 1 for a successful search with no matches. Do
    // not let that normal inspection outcome derail the agent's plan.
    if (code === 1 && /^(?:rg|grep)\b/i.test(fixed.trim()) && !stderr) {
      return `No matches found${stdout ? `\n${stdout.slice(0, 5000)}` : ""}`;
    }
    const details = [stdout, stderr].filter(Boolean).join("\n").slice(0, 5000);
    const attemptStr = attempts > 1 ? ` (after ${attempts} attempts)` : "";
    return `Exit: ${code}${attemptStr}\n${details || lastErr.message}`;
  },
};
