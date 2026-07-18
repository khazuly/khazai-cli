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

// Non-interactive shell inspection is allowed so the agent can behave like a
// normal CLI. Keep blocking pagers because they can wait for terminal input.
const INTERACTIVE_PAGER = /(?:^|[;&|]\s*)\s*(?:less|more)\b/i;

export const bashTool = {
  name: "bash",
  description: `Execute shell commands in your project environment.

## Git workflow
When the user asks to commit or push:
1. FIRST, run in parallel: git status, git diff, git log --oneline -5
2. Review the output, then commit with \`git commit -am "message"\` (never \`git add .\`)
3. BEFORE pushing, run git status and git log --oneline -3 to verify
4. Only then run git push

If push fails with auth error and the user provided a token in their message, set the remote URL with that token: \`git remote set-url origin https://<THE_TOKEN>@github.com/<user>/<repo>.git\` then retry push.
If no token provided, guide the user: \`git remote set-url origin https://<TOKEN>@github.com/<user>/<repo>.git\`
- NEVER update git config. NEVER use \`git push -i\`.
- For PRs: push with \`-u\` flag, then use \`gh pr create\`.`,
  parameters: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number", description: "timeout in seconds" }, workdir: { type: "string" } }, required: ["command"] },
  async execute({ command, timeout = 60, workdir }) {
    const cwd = workdir ? resolve(process.cwd(), String(workdir)) : process.cwd();
    const fixed = fixCommand(command);

    if (INTERACTIVE_PAGER.test(fixed)) {
      return "Error: interactive pagers are not supported";
    }

    try {
      const { stdout: out } = await execAsync(fixed, { cwd, timeoutMs: Number(timeout) * 1000 });
      return `Exit: 0\n${out.slice(0, 5000)}${out.length > 5000 ? `\n... (${out.length - 5000} more)` : ""}`;
    } catch (lastErr) {
      const stderr = lastErr.stderr?.trim() ?? "";
      const stdout = lastErr.stdout?.trim() ?? "";
      const code = lastErr.status ?? -1;
      if (code === 1 && /^(?:rg|grep)\b/i.test(fixed.trim()) && !stderr) {
        return `No matches found${stdout ? `\n${stdout.slice(0, 5000)}` : ""}`;
      }
      const details = [stdout, stderr].filter(Boolean).join("\n").slice(0, 5000);
      return `Exit: ${code}\n${details || lastErr.message}`;
    }
  },
};
