import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const IGNORED = new Set([".git", "node_modules", ".cache", "dist", "build"]);
const MAX_FILES = 2_000;
const MAX_REFERENCES = 5;
const MAX_REFERENCE_CHARS = 20_000;

function insideWorkspace(path, workspace) {
  const rel = relative(resolve(workspace), resolve(path));
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("/");
}

export function listWorkspaceFiles(workspace, maximum = MAX_FILES) {
  const root = resolve(workspace);
  const files = [];
  const pending = [root];
  while (pending.length && files.length < maximum) {
    const directory = pending.pop();
    let entries = [];
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (IGNORED.has(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(relative(root, path));
      if (files.length >= maximum) break;
    }
  }
  return files.sort();
}

export function referencedPaths(input) {
  return [...String(input || "").matchAll(/(?:^|\s)@((?:"[^"]+")|(?:'[^']+')|[^\s]+)/g)]
    .map(match => match[1].replace(/^["']|["']$/g, ""))
    .filter(Boolean)
    .filter((path, index, all) => all.indexOf(path) === index)
    .slice(0, MAX_REFERENCES);
}

export function attachFileReferences(input, workspace) {
  const blocks = [];
  for (const relativePath of referencedPaths(input)) {
    const path = resolve(workspace, relativePath);
    if (!insideWorkspace(path, workspace)) continue;
    try {
      if (!statSync(path).isFile()) continue;
      const buffer = readFileSync(path);
      if (buffer.subarray(0, 8_000).includes(0)) continue;
      const content = buffer.toString("utf-8");
      const visible = content.slice(0, MAX_REFERENCE_CHARS);
      blocks.push([
        `[Referenced file: ${relativePath}]`,
        visible,
        content.length > visible.length ? `[Truncated ${content.length - visible.length} characters]` : "",
      ].filter(Boolean).join("\n"));
    } catch {}
  }
  return blocks.length ? `${input}\n\n${blocks.join("\n\n")}` : input;
}
