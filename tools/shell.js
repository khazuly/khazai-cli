import { resolve } from "node:path";
import { execAsync } from "../lib/exec-async.js";
import {
  mutatesGitForVerification,
  parseTestReport,
  shellTimeoutMs,
  testExecutionProfile,
  unsafeTestPipeline,
} from "../lib/shell-command-policy.js";

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

function testResultMetadata(profile, report, outcome, timeoutMs, exitCode, elapsedMs) {
  if (!profile) return {};
  return {
    testExecution: {
      scope: profile.scope,
      outcome,
      timeoutMs,
      exitCode,
      passed: report?.passed || 0,
      failed: report?.failed || 0,
      cancelled: report?.cancelled || 0,
      durationMs: report?.durationMs ?? elapsedMs,
      firstFailure: report?.firstFailure || "",
    },
  };
}

function testResultLine(report, elapsedMs) {
  if (!report) return "";
  const durationMs = report.durationMs ?? elapsedMs;
  return `Test results: ${report.passed} passed, ${report.failed} failed, ${report.cancelled} cancelled · ${(durationMs / 1000).toFixed(1)}s`;
}

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
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeout: { type: "number", description: "Timeout in seconds." },
      workdir: { type: "string" },
      retryReason: { type: "string", description: "Required justification for retrying a failed identical command." },
    },
    required: ["command"],
  },
  async execute({ command, timeout, workdir, env }, context = {}) {
    const cwd = workdir ? resolve(process.cwd(), String(workdir)) : process.cwd();
    const fixed = fixCommand(command);
    const profile = testExecutionProfile(fixed, cwd);
    const timeoutMs = Math.max(1_000, shellTimeoutMs(fixed, cwd, timeout));

    if (INTERACTIVE_PAGER.test(fixed)) {
      return "Error: interactive pagers are not supported";
    }
    if (unsafeTestPipeline(fixed)) {
      return "Exit: 2\nRun test commands directly; grep and tail pipelines can hide the test runner exit status.";
    }
    if (mutatesGitForVerification(fixed)) {
      return "Exit: 2\nGit working-tree mutation is not allowed during test verification.";
    }

    const startedAt = Date.now();
    try {
      const { stdout, stderr } = await execAsync(fixed, {
        cwd,
        timeoutMs,
        env,
        signal: context.signal,
        pipefail: true,
      });
      const output = [stdout, stderr].filter(Boolean).join("\n");
      const report = profile ? parseTestReport(output) : null;
      const summary = testResultLine(report, Date.now() - startedAt);
      if (!profile) return `Exit: 0\n${output}`;
      const outcome = report?.failed ? "failed" : "passed";
      const exitCode = report?.failed ? 1 : 0;
      return {
        output: `Exit: ${exitCode}\n${[summary, report?.firstFailure, output].filter(Boolean).join("\n")}`,
        metadata: testResultMetadata(profile, report, outcome, timeoutMs, exitCode, Date.now() - startedAt),
      };
    } catch (lastErr) {
      const stderr = lastErr.stderr?.trim() ?? "";
      const stdout = lastErr.stdout?.trim() ?? "";
      const code = lastErr.status ?? -1;
      if (code === 1 && /^(?:rg|grep)\b/i.test(fixed.trim()) && !stderr) {
        return `No matches found${stdout ? `\n${stdout.slice(0, 5000)}` : ""}`;
      }
      const details = [stdout, stderr].filter(Boolean).join("\n");
      const report = profile ? parseTestReport(details) : null;
      const timedOut = lastErr.killed && /timed out/i.test(lastErr.message);
      const hanging = timedOut && report && report.failed === 0 && report.durationMs !== null;
      const outcome = hanging ? "hanging" : timedOut ? "timeout" : report?.failed ? "failed" : "exit-error";
      const seconds = Math.round(timeoutMs / 1000);
      const headline = hanging
        ? `Test process did not exit after completed output · ${seconds}s`
        : timedOut && profile?.scope === "full"
          ? `Test suite timed out after ${seconds}s`
          : timedOut
            ? `Test command timed out after ${seconds}s`
            : testResultLine(report, Date.now() - startedAt);
      const firstFailure = report?.firstFailure ? `First failure: ${report.firstFailure}` : "";
      if (!profile) return `Exit: ${code}\n${details || lastErr.message}`;
      return {
        output: `Exit: ${code}\n${[headline, firstFailure, details || lastErr.message].filter(Boolean).join("\n")}`,
        metadata: testResultMetadata(profile, report, outcome, timeoutMs, code, Date.now() - startedAt),
      };
    }
  },
};
