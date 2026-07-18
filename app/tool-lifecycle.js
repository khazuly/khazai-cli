import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function now() {
  return Date.now();
}

function id(prefix) {
  return `${prefix}_${randomUUID()}`;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(workspace, args) {
  return execFileSync("git", args, {
    cwd: workspace,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function hasGitMarker(workspace) {
  let current = resolve(workspace);
  while (true) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function gitStatusSnapshot(workspace) {
  const entries = git(workspace, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"])
    .split("\0")
    .filter(Boolean);
  const paths = [];
  let head = "(initial)";
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.startsWith("# branch.oid ")) {
      head = entry.slice("# branch.oid ".length);
      continue;
    }
    if (entry.startsWith("? ")) {
      paths.push(entry.slice(2));
      continue;
    }
    const ordinary = /^1 (?:\S+ ){7}(.+)$/.exec(entry);
    if (ordinary) {
      paths.push(ordinary[1]);
      continue;
    }
    const renamed = /^2 (?:\S+ ){8}(.+)$/.exec(entry);
    if (renamed) {
      paths.push(renamed[1]);
      if (entries[index + 1]) paths.push(entries[++index]);
      continue;
    }
    const unmerged = /^u (?:\S+ ){9}(.+)$/.exec(entry);
    if (unmerged) paths.push(unmerged[1]);
  }
  return { head, paths: [...new Set(paths)].sort() };
}

function fileFingerprint(workspace, path) {
  const absolute = resolve(workspace, path);
  if (!existsSync(absolute)) return "deleted";
  const stat = statSync(absolute);
  if (!stat.isFile()) return `other:${stat.mode & 0o777}`;
  return `${stat.mode & 0o777}:${hash(readFileSync(absolute))}`;
}

export function captureWorkspaceSnapshot(workspace) {
  try {
    const root = resolve(workspace);
    if (!hasGitMarker(root)) return null;
    const status = gitStatusSnapshot(root);
    const files = Object.fromEntries(status.paths.map(path => [path, fileFingerprint(root, path)]));
    const head = status.head;
    return {
      hash: hash(JSON.stringify({ head, files })),
      head,
      files,
      createdAt: now(),
    };
  } catch {
    return null;
  }
}

export function changedSnapshotFiles(before, after) {
  if (!before || !after) return [];
  const paths = new Set([...Object.keys(before.files || {}), ...Object.keys(after.files || {})]);
  return [...paths].filter(path => before.files?.[path] !== after.files?.[path]).sort();
}

export function normalizeToolOutput(value, tool = "tool") {
  if (value && typeof value === "object" && !Array.isArray(value) && !value.needsSteering) {
    const output = Object.hasOwn(value, "output") ? String(value.output ?? "") : JSON.stringify(value);
    return {
      title: String(value.title || tool),
      output,
      metadata: value.metadata && typeof value.metadata === "object" ? { ...value.metadata } : {},
      attachments: Array.isArray(value.attachments) ? value.attachments : [],
    };
  }
  return {
    title: tool,
    output: typeof value === "string" ? value : JSON.stringify(value),
    metadata: {},
    attachments: [],
  };
}

export class ToolLifecycle {
  constructor({ sessionId = randomUUID(), workspace = process.cwd(), parts = [], onPart = null } = {}) {
    this.sessionId = String(sessionId);
    this.workspace = resolve(workspace);
    this.parts = Array.isArray(parts) ? parts.map(part => ({ ...part })) : [];
    this.messageId = null;
    this.snapshot = null;
    this.onPart = typeof onPart === "function" ? onPart : null;
  }

  _emit(part) {
    try { this.onPart?.(JSON.parse(JSON.stringify(part))); } catch {}
    return part;
  }

  startStep(messageId = id("message")) {
    this.messageId = String(messageId);
    this.snapshot = captureWorkspaceSnapshot(this.workspace);
    if (!this.snapshot) return null;
    const part = {
      id: id("part"),
      sessionId: this.sessionId,
      messageId: this.messageId,
      type: "snapshot",
      snapshot: this.snapshot.hash,
      time: { created: now() },
    };
    this.parts.push(part);
    return this._emit(part);
  }

  pending({ callId = id("call"), tool, input = {}, metadata = {} }) {
    const part = {
      id: id("part"),
      sessionId: this.sessionId,
      messageId: this.messageId || id("message"),
      type: "tool",
      callId: String(callId),
      tool: String(tool),
      state: { status: "pending", input: { ...input }, raw: "" },
      metadata: { ...metadata },
    };
    this.parts.push(part);
    return this._emit(part);
  }

  running(part, input = part.state.input) {
    part.state = {
      status: "running",
      input: { ...input },
      time: { start: now() },
      metadata: { ...(part.state.metadata || {}) },
    };
    return this._emit(part);
  }

  metadata(part, metadata = {}) {
    if (part.state?.status !== "running") return part;
    part.state = {
      ...part.state,
      metadata: { ...(part.state.metadata || {}), ...(metadata || {}) },
    };
    return this._emit(part);
  }

  completed(part, output) {
    const normalized = normalizeToolOutput(output, part.tool);
    const start = part.state.time?.start || now();
    part.state = {
      status: "completed",
      input: { ...(part.state.input || {}) },
      output: normalized.output,
      title: normalized.title,
      metadata: normalized.metadata,
      attachments: normalized.attachments,
      time: { start, end: now() },
    };
    return this._emit(part);
  }

  failed(part, error, metadata = {}) {
    const start = part.state.time?.start || now();
    part.state = {
      status: "error",
      input: { ...(part.state.input || {}) },
      error: error instanceof Error ? error.message : String(error),
      metadata: { ...metadata },
      time: { start, end: now() },
    };
    return this._emit(part);
  }

  finishStep(reason = "stop") {
    const after = captureWorkspaceSnapshot(this.workspace);
    const files = changedSnapshotFiles(this.snapshot, after);
    const created = now();
    const emitted = [];
    if (files.length) {
      const patch = {
        id: id("part"),
        sessionId: this.sessionId,
        messageId: this.messageId || id("message"),
        type: "patch",
        hash: hash(JSON.stringify({ before: this.snapshot?.hash, after: after?.hash, files })),
        files,
        time: { created },
      };
      this.parts.push(patch);
      this._emit(patch);
      emitted.push(patch);
    }
    const finish = {
      id: id("part"),
      sessionId: this.sessionId,
      messageId: this.messageId || id("message"),
      type: "step-finish",
      reason,
      snapshot: after?.hash,
      time: { created },
    };
    this.parts.push(finish);
    this._emit(finish);
    emitted.push(finish);
    this.snapshot = null;
    this.messageId = null;
    return emitted;
  }
}
