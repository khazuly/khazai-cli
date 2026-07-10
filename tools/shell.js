import { execSync } from "node:child_process";
import { resolve } from "node:path";

export const bashTool = {
  name: "bash",
  description: "Execute a shell command.",
  parameters: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number" }, workdir: { type: "string" } }, required: ["command"] },
  async execute({ command, timeout = 30000, workdir }) {
    const cwd = workdir ? resolve(process.cwd(), String(workdir)) : process.cwd();
    try {
      const out = execSync(String(command), { cwd, encoding: "utf-8", timeout: Number(timeout), maxBuffer: 50000 });
      const d = out.trim();
      return `Exit: 0\n${d.slice(0, 5000)}${d.length > 5000 ? `\n... (${d.length - 5000} more)` : ""}`;
    } catch (err) {
      const stderr = err.stderr?.trim() ?? "";
      const stdout = err.stdout?.trim() ?? "";
      const code = err.status ?? -1;
      const details = [stdout, stderr].filter(Boolean).join("\n").slice(0, 5000);
      return `${err.killed ? `Timeout ${timeout}ms\n` : ""}Exit: ${code}\n${details || err.message}`;
    }
  },
};
