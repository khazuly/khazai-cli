import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { requireWorkspace, validateSource } from "./file.js";

function parsePatch(source) {
  const lines = String(source || "").replace(/\r\n/g, "\n").trimEnd().split("\n");
  if (lines.shift() !== "*** Begin Patch" || lines.pop() !== "*** End Patch") {
    throw new Error("Patch must begin with *** Begin Patch and end with *** End Patch.");
  }
  const operations = [];
  let index = 0;
  while (index < lines.length) {
    const header = /^\*\*\* (Add File|Update File|Delete File): (.+)$/.exec(lines[index++]);
    if (!header) throw new Error(`Invalid patch operation near line ${index + 1}.`);
    const operation = { type: header[1], path: header[2], moveTo: "", hunks: [], content: [] };
    if (operation.type === "Add File") {
      while (index < lines.length && !lines[index].startsWith("*** ")) {
        if (!lines[index].startsWith("+")) throw new Error(`Added file content must start with + near line ${index + 2}.`);
        operation.content.push(lines[index++].slice(1));
      }
    } else if (operation.type === "Update File") {
      if (lines[index]?.startsWith("*** Move to: ")) operation.moveTo = lines[index++].slice(13);
      let hunk = null;
      while (index < lines.length && !/^\*\*\* (?:Add|Update|Delete) File: /.test(lines[index])) {
        if (lines[index].startsWith("@@")) {
          hunk = [];
          operation.hunks.push(hunk);
          index++;
          continue;
        }
        if (!hunk || !/^[ +\-]/.test(lines[index])) throw new Error(`Invalid update hunk near line ${index + 2}.`);
        hunk.push(lines[index++]);
      }
      if (operation.hunks.length === 0) throw new Error(`Update for ${operation.path} has no hunks.`);
    }
    operations.push(operation);
  }
  return operations;
}

function assertSafePath(path, workspace) {
  const absolute = resolve(workspace, path);
  requireWorkspace(absolute, workspace);
  let cursor = absolute;
  while (cursor !== workspace && cursor !== dirname(cursor)) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`Symbolic links are not allowed in patch paths: ${path}`);
    cursor = dirname(cursor);
  }
  return absolute;
}

function applyHunks(content, hunks, path) {
  let next = content;
  for (const lines of hunks) {
    const before = lines.filter(line => line[0] !== "+").map(line => line.slice(1)).join("\n");
    const after = lines.filter(line => line[0] !== "-").map(line => line.slice(1)).join("\n");
    const offset = next.indexOf(before);
    if (offset < 0) throw new Error(`Patch context was not found in ${path}.`);
    if (next.indexOf(before, offset + 1) >= 0) throw new Error(`Patch context is ambiguous in ${path}.`);
    next = `${next.slice(0, offset)}${after}${next.slice(offset + before.length)}`;
  }
  return next;
}

export const applyPatchTool = {
  name: "apply_patch",
  description: "Apply an atomic multi-file patch using Begin Patch/Add File/Update File/Delete File markers.",
  parameters: {
    type: "object",
    properties: {
      patchText: { type: "string", description: "The complete patch text." },
    },
    required: ["patchText"],
    additionalProperties: false,
  },
  async execute({ patchText, _agentWorkspace }) {
    const workspace = resolve(_agentWorkspace || process.cwd());
    let operations;
    try { operations = parsePatch(patchText); }
    catch (error) { return `Error: ${error.message}`; }
    const snapshots = new Map();
    const touched = new Set();
    try {
      for (const operation of operations) {
        const path = assertSafePath(operation.path, workspace);
        const moveTo = operation.moveTo ? assertSafePath(operation.moveTo, workspace) : null;
        for (const target of [path, moveTo].filter(Boolean)) {
          if (!snapshots.has(target)) snapshots.set(target, existsSync(target) ? readFileSync(target) : null);
          touched.add(target);
        }
        if (operation.type === "Add File") {
          if (existsSync(path)) throw new Error(`File already exists: ${operation.path}`);
          const content = operation.content.join("\n");
          const invalid = validateSource(path, content);
          if (invalid) throw new Error(invalid);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, content, "utf-8");
        } else if (operation.type === "Delete File") {
          if (!existsSync(path)) throw new Error(`File not found: ${operation.path}`);
          rmSync(path);
        } else {
          if (!existsSync(path)) throw new Error(`File not found: ${operation.path}`);
          const content = applyHunks(readFileSync(path, "utf-8"), operation.hunks, operation.path);
          const destination = moveTo || path;
          if (moveTo && existsSync(moveTo)) throw new Error(`Move destination already exists: ${operation.moveTo}`);
          const invalid = validateSource(destination, content);
          if (invalid) throw new Error(invalid);
          mkdirSync(dirname(destination), { recursive: true });
          writeFileSync(path, content, "utf-8");
          if (moveTo) renameSync(path, moveTo);
        }
      }
      return `Applied patch to ${touched.size} file${touched.size === 1 ? "" : "s"}.`;
    } catch (error) {
      for (const [path, snapshot] of [...snapshots.entries()].reverse()) {
        try {
          if (snapshot === null) rmSync(path, { force: true });
          else {
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, snapshot);
          }
        } catch {}
      }
      return `Error: ${error.message}`;
    }
  },
};
