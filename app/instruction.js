import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const OPTIONAL_FILES = ["CLAUDE.md", "CONTEXT.md"];
const OPTIONAL_LIMIT = 3000;
const workspaceCache = new Map();

function canonical(path) {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function inside(path, root) {
  const value = relative(root, path);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function nearest(filename, start, root) {
  let current = inside(start, root) ? start : root;
  while (true) {
    const path = join(current, filename);
    try {
      if (statSync(path).isFile()) return path;
    } catch {}
    if (current === root) return null;
    const parent = dirname(current);
    if (parent === current || !inside(parent, root)) return null;
    current = parent;
  }
}

function fileState(path) {
  if (!path) return { path: null, signature: "missing", content: "", hash: "", warning: "" };
  let stat;
  try {
    stat = statSync(path);
  } catch (error) {
    return { path, signature: `${path}:unreadable`, content: "", hash: "", warning: `Could not read workspace instructions at ${path}: ${error.message}` };
  }
  const signature = `${path}:${stat.mtimeMs}:${stat.size}:${stat.ctimeMs}`;
  try {
    const content = readFileSync(path, "utf-8");
    const hash = createHash("sha256").update(content).digest("hex");
    return { path, signature, content, hash, warning: "" };
  } catch (error) {
    return { path, signature, content: "", hash: "", warning: `Could not read workspace instructions at ${path}: ${error.message}` };
  }
}

function cachedFile(path, previous) {
  if (!path) return fileState(null);
  try {
    const stat = statSync(path);
    const signature = `${path}:${stat.mtimeMs}:${stat.size}:${stat.ctimeMs}`;
    if (previous?.signature === signature) return previous;
  } catch {}
  return fileState(path);
}

export class InstructionService {
  constructor(workspace, root = workspace) {
    this.workspace = canonical(workspace);
    this.root = canonical(root);
    this.key = `${this.root}\0${this.workspace}`;
    this.reportedWarning = "";
    this.lastLoadMs = 0;
  }

  snapshot() {
    const started = performance.now();
    const previous = workspaceCache.get(this.key) || { files: new Map() };
    const paths = [
      nearest("AGENTS.md", this.workspace, this.root),
      ...OPTIONAL_FILES.map(name => nearest(name, this.workspace, this.root)),
    ].filter((path, index, all) => path && all.indexOf(path) === index);
    const files = new Map(paths.map(path => [path, cachedFile(path, previous.files.get(path))]));
    const entries = [...files.values()];
    const revision = entries.length
      ? entries.map(entry => `${entry.signature}:${entry.hash}`).join("|")
      : `${this.root}:missing`;
    const value = { files, entries, revision, warnings: entries.map(entry => entry.warning).filter(Boolean) };
    workspaceCache.set(this.key, value);
    this.lastLoadMs = performance.now() - started;
    return value;
  }

  revision() {
    return this.snapshot().revision;
  }

  getSystemPromptBlock() {
    const snapshot = this.snapshot();
    if (!snapshot.entries.some(entry => entry.content)) return "";
    const lines = [
      "WORKSPACE INSTRUCTIONS (HIGH PRIORITY):",
      "Follow these instructions for planning, tools, edits, verification, and the final response.",
      "Application safety and permission rules always take precedence.",
    ];
    for (const entry of snapshot.entries) {
      if (!entry.content) continue;
      const optional = !entry.path.endsWith("AGENTS.md") && entry.content.length > OPTIONAL_LIMIT;
      const content = optional ? `${entry.content.slice(0, OPTIONAL_LIMIT)}\n...(truncated)` : entry.content;
      lines.push(`Path: ${entry.path}`, content.trim(), "");
    }
    return lines.join("\n");
  }

  takeWarning() {
    const warning = this.snapshot().warnings[0] || "";
    if (!warning || warning === this.reportedWarning) return "";
    this.reportedWarning = warning;
    return warning;
  }

  clearCache() {
    workspaceCache.delete(this.key);
  }
}
