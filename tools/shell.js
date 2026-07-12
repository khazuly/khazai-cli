import { resolve } from "node:path";
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

export const bashTool = {
  name: "bash",
  description: "Execute a shell command (timeout in seconds). Retries up to 2 times on timeout with doubled timeout.",
  parameters: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number", description: "timeout in seconds" }, workdir: { type: "string" } }, required: ["command"] },
  async execute({ command, timeout = 60, workdir }) {
    const cwd = workdir ? resolve(process.cwd(), String(workdir)) : process.cwd();
    const fixed = fixCommand(command);

    if (SERVER_CMDS.test(fixed)) {
      return `BLOCKED: Cannot start a long-running server. It will hang forever.\nInstead, write all files and tell the user to run it themselves.\n\nTo run: cd ${workdir || "."} && ${fixed.split("&&")[0].trim()}`;
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
    const details = [stdout, stderr].filter(Boolean).join("\n").slice(0, 5000);
    const attemptStr = attempts > 1 ? ` (after ${attempts} attempts)` : "";
    return `Exit: ${code}${attemptStr}\n${details || lastErr.message}`;
  },
};
