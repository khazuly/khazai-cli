import { resolve } from "node:path";
import { execAsync } from "../lib/exec-async.js";

export const bashTool = {
  name: "bash",
  description: "Execute a shell command (timeout in seconds). Retries up to 2 times on timeout with doubled timeout.",
  parameters: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number", description: "timeout in seconds" }, workdir: { type: "string" } }, required: ["command"] },
  async execute({ command, timeout = 60, workdir }) {
    const cwd = workdir ? resolve(process.cwd(), String(workdir)) : process.cwd();
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const t = (attempt === 1 ? Number(timeout) : Number(timeout) * (attempt === 2 ? 2 : 4)) * 1000;
      try {
        const { stdout: out } = await execAsync(command, { cwd, timeoutMs: t });
        const prefix = attempt > 1 ? `(retry #${attempt - 1}) ` : "";
        return `${prefix}Exit: 0\n${out.slice(0, 5000)}${out.length > 5000 ? `\n... (${out.length - 5000} more)` : ""}`;
      } catch (err) {
        lastErr = err;
        if (!err.killed) break;
      }
    }
    const stderr = lastErr.stderr?.trim() ?? "";
    const stdout = lastErr.stdout?.trim() ?? "";
    const code = lastErr.status ?? -1;
    const details = [stdout, stderr].filter(Boolean).join("\n").slice(0, 5000);
    return `Exit: ${code} (failed after 3 attempts)\n${details || lastErr.message}`;
  },
};
