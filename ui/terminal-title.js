import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";

const FALLBACK_TITLE = "KhazAI";
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function scopeKey(scope) {
  if (!scope?.runId || !scope?.turnId) return null;
  return `${scope.runId}:${scope.turnId}:${scope.taskEpoch ?? ""}`;
}

function cleanProjectName(value) {
  return String(value || "")
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\|$)/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "")
    .trim();
}

export function workspaceTitle(workspaceRoot, fallbackPath = process.cwd()) {
  const source = typeof workspaceRoot === "string" && workspaceRoot.trim()
    ? workspaceRoot
    : fallbackPath;
  if (typeof source !== "string" || !source.trim()) return FALLBACK_TITLE;
  let root;
  try { root = realpathSync(resolve(source)); }
  catch {
    try { root = resolve(source); }
    catch { return FALLBACK_TITLE; }
  }
  return cleanProjectName(basename(root)) || FALLBACK_TITLE;
}

export function createTerminalTitle(options = {}) {
  const stdout = options.stdout || process.stdout;
  const processRef = options.processRef || process;
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;
  const fallbackPath = options.cwd || (() => {
    try { return processRef.cwd?.() || process.cwd(); } catch { return ""; }
  })();
  const enabled = Boolean(stdout?.isTTY) && processRef?.env?.TERM !== "dumb";
  let projectName = workspaceTitle(options.workspacePath, fallbackPath);
  let activeScope = null;
  let frame = 0;
  let interval = null;
  let latestScope = 0;
  const scopeOrder = new Map();
  const finishedScopes = new Set();
  const write = title => {
    if (!enabled) return;
    try { stdout.write(`\u001b]0;${title}\u0007`); } catch {}
  };
  const activeTitle = () => `${FRAMES[(frame + FRAMES.length - 1) % FRAMES.length]} ${projectName}`;
  const clear = () => {
    if (interval !== null) clearIntervalFn(interval);
    interval = null;
    activeScope = null;
    frame = 0;
    write(projectName);
  };
  const tick = () => {
    if (!activeScope) return;
    write(`${FRAMES[frame]} ${projectName}`);
    frame = (frame + 1) % FRAMES.length;
  };
  const pause = scope => {
    const key = scopeKey(scope);
    if (key && key !== activeScope) return false;
    clear();
    return true;
  };
  const finish = scope => {
    const key = scopeKey(scope);
    if (key && activeScope && key !== activeScope) return false;
    if (key) finishedScopes.add(key);
    clear();
    return true;
  };
  const start = scope => {
    const key = scopeKey(scope);
    if (!enabled || !key || finishedScopes.has(key)) return false;
    const order = scopeOrder.get(key);
    if (order && order < latestScope) return false;
    if (!order) {
      latestScope++;
      scopeOrder.set(key, latestScope);
    }
    activeScope = key;
    if (interval === null) {
      tick();
      interval = setIntervalFn(tick, 100);
    }
    return true;
  };
  const setWorkspace = workspaceRoot => {
    const next = workspaceTitle(workspaceRoot, fallbackPath);
    if (next === projectName) return false;
    projectName = next;
    write(activeScope ? activeTitle() : projectName);
    return true;
  };
  const restore = () => finish();
  processRef?.once?.("exit", restore);
  processRef?.once?.("SIGINT", restore);
  processRef?.once?.("SIGTERM", restore);
  write(projectName);
  return {
    start,
    pause,
    finish,
    setWorkspace,
    dispose() {
      finish();
      processRef?.removeListener?.("exit", restore);
      processRef?.removeListener?.("SIGINT", restore);
      processRef?.removeListener?.("SIGTERM", restore);
    },
  };
}
