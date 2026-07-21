import { createElement as h } from "react";
import { basename, extname } from "node:path";
import { resolveLanguage } from "../../lib/syntax-highlighter.js";
import { CodePanel } from "./code-panel.js";

const MAX_PREVIEW_LINES = 20;

const EXTENSIONS = {
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "typescript",
  ".json": "json",
  ".py": "python",
  ".sh": "bash", ".bash": "bash", ".zsh": "bash",
  ".html": "html", ".htm": "html",
  ".css": "css",
  ".md": "markdown", ".mdx": "markdown",
  ".yaml": "yaml", ".yml": "yaml",
  ".sql": "sql",
  ".rs": "rust",
  ".go": "go",
  ".rb": "ruby",
};

function languageForPath(path) {
  const key = EXTENSIONS[extname(path)];
  return resolveLanguage(key) || "plain";
}

function lineDiff(before, after) {
  const oldLines = String(before).split("\n");
  const newLines = String(after).split("\n");

  if (oldLines.length * newLines.length > 40_000) {
    return [
      ...oldLines.map((text, index) => ({ type: "delete", text, oldLine: index + 1 })),
      ...newLines.map((text, index) => ({ type: "add", text, newLine: index + 1 })),
    ];
  }

  const table = Array.from({ length: oldLines.length + 1 }, () => new Uint16Array(newLines.length + 1));
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      table[i][j] = oldLines[i] === newLines[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const rows = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      rows.push({ type: "context", text: oldLines[i], oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      rows.push({ type: "delete", text: oldLines[i], oldLine: i + 1 });
      i++;
    } else {
      rows.push({ type: "add", text: newLines[j], newLine: j + 1 });
      j++;
    }
  }
  while (i < oldLines.length) rows.push({ type: "delete", text: oldLines[i], oldLine: ++i });
  while (j < newLines.length) rows.push({ type: "add", text: newLines[j], newLine: ++j });
  return rows;
}

function collapseContext(rows) {
  const collapsed = [];
  let index = 0;
  while (index < rows.length) {
    if (rows[index].type !== "context") {
      collapsed.push(rows[index++]);
      continue;
    }

    const start = index;
    while (index < rows.length && rows[index].type === "context") index++;
    const run = rows.slice(start, index);
    if (run.length <= 6) {
      collapsed.push(...run);
    } else {
      collapsed.push(...run.slice(0, 3));
      collapsed.push({ type: "omitted", text: `… ${run.length - 6} unchanged lines` });
      collapsed.push(...run.slice(-3));
    }
  }
  return collapsed;
}

function SyntaxPanel({ title, language, rows }) {
  return h(CodePanel, { title, language, rows, maximumRows: MAX_PREVIEW_LINES });
}

export function MarkdownCodeBlock({ content, language }) {
  const resolvedLanguage = resolveLanguage(language) || "plain";
  const rows = String(content).split("\n").map((text, index) => ({ type: "context", text, oldLine: index + 1, newLine: index + 1 }));
  return h(SyntaxPanel, {
    title: "Code",
    language: resolvedLanguage,
    rows,
  });
}

export function CodePreview({ tool, args, expanded = false }) {
  const path = String(args?.path || "untitled");
  const language = languageForPath(path);
  const isEdit = tool === "edit";
  const diff = isEdit ? lineDiff(args?.oldString ?? "", args?.newString ?? "") : [];
  const additions = diff.filter(row => row.type === "add").length;
  const deletions = diff.filter(row => row.type === "delete").length;
  const rows = isEdit
    ? expanded ? collapseContext(diff) : diff.filter(row => row.type !== "context")
    : String(args?.content ?? "").split("\n").map((text, index) => ({ type: "context", text, oldLine: index + 1, newLine: index + 1 }));
  const title = isEdit
    ? `${basename(path)} · ${language} · +${additions} −${deletions}`
    : `${basename(path)} · ${language}`;

  return h(SyntaxPanel, {
    title,
    language,
    rows,
  });
}
