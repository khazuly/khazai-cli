import { createElement as h } from "react";
import { Box, Text, useStdout } from "ink";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { useTheme } from "../theme.js";
import { resolveLanguage, highlightLine } from "../../lib/syntax-highlighter.js";
import { extname } from "node:path";

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

function fitLine(value, width) {
  const characters = Array.from(String(value));
  if (characters.length <= width) return characters.join("");
  if (width <= 1) return "…".slice(0, width);
  return characters.slice(0, width - 1).join("") + "…";
}

function DiffLine({ type, text, language, width, theme, lineNumber }) {
  const prefix = type === "delete" ? "−" : type === "add" ? "+" : " ";
  const prefixColor = type === "delete" ? theme.error : type === "add" ? theme.success : theme.muted;
  const lineText = fitLine(text, Math.max(1, width - 3));
  const parts = theme.colorEnabled ? highlightLine(lineText, language) : [{ text: lineText }];
  return h(Box, { key: lineNumber, width },
    h(Text, { color: prefixColor }, prefix),
    ...parts.map((part, i) => h(Text, { key: `${lineNumber}-${i}`, color: part.color || theme.assistant }, part.text)),
  );
}

function PreviewContent({ title, language, lines, theme, width }) {
  const limited = lines.length > MAX_PREVIEW_LINES
    ? [...lines.slice(0, MAX_PREVIEW_LINES), { type: "omitted", text: `… ${lines.length - MAX_PREVIEW_LINES} more lines` }]
    : lines;
  return h(Box, { flexDirection: "column", width },
    h(Text, { bold: true, color: theme.secondary }, `  ${title}`),
    h(Box, { flexDirection: "column" },
      ...limited.map((line, index) => {
        if (line.type === "omitted") {
          return h(Text, { key: index, color: theme.metadata }, `  ${line.text}`);
        }
        return h(DiffLine, {
          key: index,
          type: line.type,
          text: line.text,
          language,
          width,
          theme,
          lineNumber: index,
        });
      }),
    ),
  );
}

function computeEditLines(args) {
  const oldText = String(args?.oldString || args?.old_string || "");
  const newText = String(args?.newString || args?.new_string || "");
  if (!oldText && !newText) return [];

  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  // Simple diff: show removed lines then added lines.
  // For a real diff we'd use LCS, but for streaming preview this is sufficient.
  const lines = [];
  for (const line of oldLines) {
    lines.push({ type: "delete", text: line });
  }
  for (const line of newLines) {
    lines.push({ type: "add", text: line });
  }
  return lines;
}

function computeWriteLines(args) {
  const content = String(args?.content || "");
  if (!content) return [];
  return content.split("\n").map(text => ({ type: "add", text }));
}

function computePatchLines(args) {
  const patchText = String(args?.patchText || args?.patch_text || "");
  if (!patchText) return [];

  const lines = [];
  const patchLines = patchText.split("\n");
  let inHunk = false;

  for (const line of patchLines) {
    // Detect file headers and hunks in unified diff format.
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
  const { stdout } = useStdout();
  const theme = useTheme();
  const width = Math.max(16, (stdout?.columns || 80) - 2);
  const path = String(args?.path || args?.file || "");

  if (tool === "edit" && (state === "running" || state === "pending")) {
    const lines = computeEditLines(args);
    if (lines.length === 0) return null;
    return h(PreviewContent, {
      title: `Edit  ${path}`,
      language: languageForPath(path),
      lines,
      theme,
      width,
    });
  }

  if (tool === "write" && (state === "running" || state === "pending")) {
    const lines = computeWriteLines(args);
    if (lines.length === 0) return null;
    return h(PreviewContent, {
      title: `Write  ${path}`,
      language: languageForPath(path),
      lines,
      theme,
      width,
    });
  }

  if (tool === "apply_patch" && (state === "running" || state === "pending")) {
    const lines = computePatchLines(args);
    if (lines.length === 0) return null;
    return h(PreviewContent, {
      title: "Patch",
      language: "diff",
      lines,
      theme,
      width,
    });
  }

  return null;
}
