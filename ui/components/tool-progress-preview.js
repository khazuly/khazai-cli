import { createElement as h } from "react";
import { resolveLanguage } from "../../lib/syntax-highlighter.js";
import { extname } from "node:path";
import { CodePanel } from "./code-panel.js";

const MAX_PREVIEW_LINES = 12;

const EXTENSIONS = {
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "typescript",
  ".json": "json", ".py": "python",
  ".sh": "bash", ".bash": "bash", ".zsh": "bash",
  ".html": "html", ".htm": "html",
  ".css": "css", ".md": "markdown", ".mdx": "markdown",
  ".yaml": "yaml", ".yml": "yaml",
  ".sql": "sql", ".rs": "rust", ".go": "go", ".rb": "ruby",
};

function languageForPath(path) {
  return resolveLanguage(EXTENSIONS[extname(path)]) || "plain";
}

function computeEditLines(args) {
  const oldText = String(args?.oldString || args?.old_string || "");
  const newText = String(args?.newString || args?.new_string || "");
  if (!oldText && !newText) return [];

  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  const lines = [];
  for (const [index, line] of oldLines.entries()) {
    lines.push({ type: "delete", text: line, oldLine: index + 1 });
  }
  for (const [index, line] of newLines.entries()) {
    lines.push({ type: "add", text: line, newLine: index + 1 });
  }
  return lines;
}

function computeWriteLines(args) {
  const content = String(args?.content || "");
  if (!content) return [];
  return content.split("\n").map((text, index) => ({ type: "add", text, newLine: index + 1 }));
}

function computePatchLines(args) {
  const patchText = String(args?.patchText || args?.patch_text || "");
  if (!patchText) return [];

  const lines = [];
  const patchLines = patchText.split("\n");
  let inHunk = false;

  for (const line of patchLines) {
    if (line.startsWith("*** ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      lines.push({ type: "omitted", text: line });
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@")) {
      lines.push({ type: "context", text: line });
      inHunk = true;
      continue;
    }
    if (inHunk && line.startsWith("-")) {
      lines.push({ type: "delete", text: line.slice(1) });
      continue;
    }
    if (inHunk && line.startsWith("+")) {
      lines.push({ type: "add", text: line.slice(1) });
      continue;
    }
    if (inHunk) {
      lines.push({ type: "context", text: line });
    }
  }
  return lines;
}

export function ToolProgressPreview({ tool, args, state }) {
  const path = String(args?.path || args?.file || "");

  if (tool === "edit" && (state === "running" || state === "pending")) {
    const lines = computeEditLines(args);
    if (lines.length === 0) return null;
    return h(CodePanel, {
      title: `Edit  ${path}`,
      language: languageForPath(path),
      rows: lines,
      maximumRows: MAX_PREVIEW_LINES,
    });
  }

  if (tool === "write" && (state === "running" || state === "pending")) {
    const lines = computeWriteLines(args);
    if (lines.length === 0) return null;
    return h(CodePanel, {
      title: `Write  ${path}`,
      language: languageForPath(path),
      rows: lines,
      maximumRows: MAX_PREVIEW_LINES,
    });
  }

  if (tool === "apply_patch" && (state === "running" || state === "pending")) {
    const lines = computePatchLines(args);
    if (lines.length === 0) return null;
    return h(CodePanel, {
      title: "Patch",
      language: "diff",
      rows: lines,
      maximumRows: MAX_PREVIEW_LINES,
    });
  }

  return null;
}
