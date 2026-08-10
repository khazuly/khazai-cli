import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const hash = value => createHash("sha256").update(value).digest("hex");

function git(workspace, args, options = {}) {
  return execFileSync("git", args, {
    cwd: workspace,
    encoding: options.encoding || "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function fileState(path) {
  if (!existsSync(path)) return { exists: false, hash: null, content: null, mode: null };
  const content = readFileSync(path);
  return { exists: true, hash: hash(content), content: content.toString("base64"), mode: statSync(path).mode & 0o777 };
}

function statusPaths(workspace) {
  const output = git(workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const entries = output.split("\0").filter(Boolean);
  const paths = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!path) continue;
    if (/R|C/.test(code) && entries[index + 1]) paths.push(entries[++index]);
    paths.push(path);
  }
  return [...new Set(paths)];
}

function headState(workspace, path) {
  try {
    const content = git(workspace, ["show", `HEAD:${path}`], { encoding: "buffer" });
    return { exists: true, hash: hash(content), content: content.toString("base64"), mode: 0o644 };
  } catch {
    return { exists: false, hash: null, content: null, mode: null };
  }
}

function stateFor(workspace, capture, path) {
  return capture.files[path] || headState(workspace, path);
}

function sameState(left, right) {
  return Boolean(left?.exists) === Boolean(right?.exists) && (left?.hash || null) === (right?.hash || null);
}

function pathFor(workspace, path) {
  const target = resolve(workspace, path);
  if (relative(workspace, target).startsWith("..")) throw new Error("Session journal contains a path outside the workspace.");
  return target;
}

function scopedPaths(workspace, paths) {
  return [...new Set(paths.map(path => relative(workspace, pathFor(workspace, path))))];
}

export function captureGitState(workspace, paths = null) {
  try {
    if (git(workspace, ["rev-parse", "--is-inside-work-tree"]).trim() !== "true") return null;
    const files = Array.isArray(paths) && paths.length
      ? scopedPaths(workspace, paths)
      : statusPaths(workspace);
    return {
      head: git(workspace, ["rev-parse", "HEAD"]).trim(),
      files: Object.fromEntries(files.map(path => [path, fileState(resolve(workspace, path))])),
    };
  } catch {
    return null;
  }
}

export function createJournal(workspace, before, after) {
  if (!before || !after || before.head !== after.head) return null;
  const paths = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])];
  const journal = {
    before: Object.fromEntries(paths.map(path => [path, stateFor(workspace, before, path)])),
    after: Object.fromEntries(paths.map(path => [path, stateFor(workspace, after, path)])),
  };
  return paths.every(path => sameState(journal.before[path], journal.after[path])) ? null : journal;
}

export function journalMatches(workspace, journal, side) {
  return Object.entries(journal?.[side] || {}).every(([path, state]) => sameState(fileState(pathFor(workspace, path)), state));
}

export function restoreJournal(workspace, journal, side) {
  for (const [path, state] of Object.entries(journal?.[side] || {})) {
    const target = pathFor(workspace, path);
    if (!state.exists) {
      rmSync(target, { recursive: true, force: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(state.content, "base64"), { mode: state.mode || 0o644 });
  }
}
