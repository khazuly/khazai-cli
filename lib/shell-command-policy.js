import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const TEST_COMMAND = /\b(?:npm|pnpm|yarn|bun)\s+(?:(?:run\s+)?test)\b|\bnode\s+--test\b|\b(?:pytest|vitest|jest)\b/i;

function normalizedCommand(command) {
  return String(command || "").replace(/\s+/g, " ").trim();
}

function countTestFiles(directory) {
  if (!existsSync(directory)) return 0;
  let count = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) count += countTestFiles(path);
    else if (/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(entry.name)) count++;
  }
  return count;
}

function configuredTestScript(cwd) {
  try {
    const value = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    return String(value?.scripts?.test || "");
  } catch {
    return "";
  }
}

function fullTestCommand(command, cwd) {
  const source = normalizedCommand(command)
    .replace(/^(?:set\s+-o\s+pipefail\s*;\s*)+/i, "")
    .replace(/^cd\s+(?:"[^"]+"|'[^']+'|[^;&|]+)\s*&&\s*/i, "");
  const packageTest = /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b(.*)$/i.exec(source);
  if (packageTest) {
    const suffix = packageTest[1].split(/\s*(?:\||&&|;)\s*/)[0].trim();
    if (!suffix) return true;
    if (/^--\s+\S/.test(suffix)) return false;
    return /^--[A-Za-z]/.test(suffix) && Boolean(configuredTestScript(cwd));
  }
  const nodeTest = /^node\s+--test\b(.*)$/i.exec(source);
  if (!nodeTest) return false;
  const targets = nodeTest[1].split(/\s*(?:\||&&|;)\s*/)[0].trim();
  return !targets || /[*?[\]]/.test(targets);
}

export function testExecutionProfile(command, cwd = process.cwd()) {
  const source = normalizedCommand(command);
  if (!TEST_COMMAND.test(source)) return null;
  const full = fullTestCommand(source, cwd);
  const testFileCount = full
    ? ["test", "tests", "__tests__"].reduce((total, name) => total + countTestFiles(join(cwd, name)), 0)
    : 0;
  const timeoutMs = full
    ? Math.min(300_000, Math.max(120_000, 60_000 + testFileCount * 1_500))
    : 60_000;
  return { scope: full ? "full" : "targeted", testFileCount, timeoutMs };
}

export function shellTimeoutMs(command, cwd, requestedSeconds) {
  const requested = Number(requestedSeconds);
  const explicit = Number.isFinite(requested) && requested > 0 ? requested * 1_000 : 0;
  const profile = testExecutionProfile(command, cwd);
  if (profile?.scope === "full") return Math.min(300_000, Math.max(profile.timeoutMs, explicit));
  return explicit || profile?.timeoutMs || 60_000;
}

export function unsafeTestPipeline(command) {
  return TEST_COMMAND.test(String(command || "")) && /\|\s*(?:grep|tail)\b/i.test(String(command || ""));
}

export function mutatesGitForVerification(command) {
  const source = String(command || "");
  return TEST_COMMAND.test(source) && /\bgit\s+(?:stash|reset|checkout)\b/i.test(source);
}

export function parseTestReport(output) {
  const text = String(output || "").replace(/\u001B(?:[@-_]|\[[0-?]*[ -/]*[@-~])/g, "");
  const number = (name, suffix) => {
    const direct = new RegExp(`^\\s*(?:#\\s*)?${name}\\s*:?\\s*(\\d+)\\b`, "im").exec(text)?.[1];
    const inline = new RegExp(`(?:^|[,;\\s])(\\d+)\\s+(?:tests?\\s+)?${suffix}\\b`, "im").exec(text)?.[1];
    return Number(direct ?? inline);
  };
  const passed = number("pass(?:ed)?", "pass(?:ed)?");
  const failed = number("fail(?:ed)?", "fail(?:ed)?");
  const cancelled = number("cancelled", "cancelled");
  const duration = /^\s*(?:#\s*)?duration_ms\s*:?\s*([\d.]+)/im.exec(text)?.[1]
    ?? /\b(?:in|time:)\s*([\d.]+)\s*s(?:ec(?:onds?)?)?\b/i.exec(text)?.[1];
  const durationMs = Number(duration) * (/duration_ms/i.test(text) ? 1 : 1_000);
  const firstFailure = text.split("\n")
    .map(line => line.trim())
    .find(line => /^(?:✖|not ok\b)|AssertionError|Test suite failed/i.test(line)) || "";
  const values = [passed, failed, cancelled, durationMs];
  if (values.every(value => !Number.isFinite(value)) && !firstFailure) return null;
  return {
    passed: Number.isFinite(passed) ? passed : 0,
    failed: Number.isFinite(failed) ? failed : 0,
    cancelled: Number.isFinite(cancelled) ? cancelled : 0,
    durationMs: Number.isFinite(durationMs) ? durationMs : null,
    firstFailure,
  };
}
