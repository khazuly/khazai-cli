import { createElement as h } from "react";
import { Text, Box, useStdout } from "ink";
import { extname } from "node:path";
import { PASTEL } from "../palette.js";
import { useTheme } from "../theme.js";

const MAX_PREVIEW_LINES = 20;

const COLORS = {
  background: "#0d1117",
  text: "#c9d1d9",
  muted: PASTEL.muted,
  keyword: PASTEL.mauve,
  string: PASTEL.blue,
  number: PASTEL.lavender,
  tag: PASTEL.sage,
  deleted: PASTEL.rose,
  added: PASTEL.sage,
  hunk: PASTEL.blue,
};

const EXTENSIONS = {
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "typescript",
  ".json": "json",
  ".py": "python",
  ".sh": "shell", ".bash": "shell", ".zsh": "shell",
  ".html": "html", ".htm": "html",
  ".css": "css",
  ".md": "markdown", ".mdx": "markdown",
  ".yaml": "yaml", ".yml": "yaml",
};

const KEYWORDS = {
  javascript: new Set("as async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch throw try typeof var void while with yield".split(" ")),
  typescript: new Set("abstract as async await break case catch class const continue declare debugger default delete do else enum export extends finally for from function get if implements import in infer instanceof interface keyof let namespace new of private protected public readonly return set static super switch throw try type typeof var void while with yield".split(" ")),
  python: new Set("and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield".split(" ")),
  shell: new Set("case do done elif else esac fi for function if in select then until while".split(" ")),
  json: new Set(["true", "false", "null"]),
  yaml: new Set(["true", "false", "null", "yes", "no"]),
};

const TOKEN_PATTERNS = {
  javascript: /\/\/.*$|\/\*.*?\*\/|`(?:\\.|[^`])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b/g,
  typescript: /\/\/.*$|\/\*.*?\*\/|`(?:\\.|[^`])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b/g,
  json: /"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?\b/g,
  python: /#.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][\w]*\b/g,
  shell: /#.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\$\{?\w+\}?|\b\d+\b|\b[A-Za-z_][\w-]*\b/g,
  html: /<!--.*?-->|<\/?[A-Za-z][^>]*>|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
  css: /\/\*.*?\*\/|#[0-9a-fA-F]{3,8}\b|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?(?:px|rem|em|%|s|ms|deg)?\b|@[\w-]+/g,
  markdown: /^#{1,6}\s.*$|`[^`]*`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]*\)/g,
  yaml: /#.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:true|false|null|yes|no)\b|-?\b\d+(?:\.\d+)?\b|^[\s-]*[\w.-]+(?=:\s)/g,
};

const LANGUAGE_ALIASES = {
  bash: "shell", sh: "shell", shell: "shell", zsh: "shell",
  js: "javascript", javascript: "javascript", jsx: "javascript",
  ts: "typescript", typescript: "typescript", tsx: "typescript",
  py: "python", python: "python",
  html: "html", css: "css", json: "json",
  md: "markdown", markdown: "markdown", yaml: "yaml", yml: "yaml",
};

function resolveLanguage(language) {
  const value = String(language || "").trim().toLowerCase();
  return LANGUAGE_ALIASES[value] || EXTENSIONS[value.startsWith(".") ? value : `.${value}`] || "plain";
}

function languageForPath(path) {
  return resolveLanguage(extname(path));
}

function tokenColor(token, language, colors) {
  if (/^(\/\/|\/\*|#|<!--)/.test(token)) return colors.muted;
  if (/^("|'|`)/.test(token)) return colors.string;
  if (language === "html" && /^</.test(token)) return colors.tag;
  if (language === "markdown" && (/^#/.test(token) || /^\*\*/.test(token))) return colors.keyword;
  if (/^(\$\{?\w+\}?|@)/.test(token)) return colors.keyword;
  if (/^-?\d/.test(token) || /^(true|false|null|yes|no)$/.test(token)) return colors.number;
  if (KEYWORDS[language]?.has(token)) return colors.keyword;
  return colors.text;
}

function tokenizeLine(line, language, colors) {
  const pattern = TOKEN_PATTERNS[language];
  if (!pattern || !line) return [{ text: line, color: colors.text }];

  const tokens = [];
  let cursor = 0;
  for (const match of line.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) tokens.push({ text: line.slice(cursor, index), color: colors.text });
    tokens.push({ text: match[0], color: tokenColor(match[0], language, colors) });
    cursor = index + match[0].length;
  }
  if (cursor < line.length) tokens.push({ text: line.slice(cursor), color: colors.text });
  return tokens.length ? tokens : [{ text: line, color: colors.text }];
}

function lineDiff(before, after) {
  const oldLines = String(before).split("\n");
  const newLines = String(after).split("\n");

  if (oldLines.length * newLines.length > 40_000) {
    return [
      ...oldLines.map(text => ({ type: "delete", text })),
      ...newLines.map(text => ({ type: "add", text })),
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
      rows.push({ type: "context", text: oldLines[i++] });
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      rows.push({ type: "delete", text: oldLines[i++] });
    } else {
      rows.push({ type: "add", text: newLines[j++] });
    }
  }
  while (i < oldLines.length) rows.push({ type: "delete", text: oldLines[i++] });
  while (j < newLines.length) rows.push({ type: "add", text: newLines[j++] });
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

function limitRows(rows) {
  if (rows.length <= MAX_PREVIEW_LINES) return rows;
  return [
    ...rows.slice(0, MAX_PREVIEW_LINES),
    { type: "omitted", text: `… ${rows.length - MAX_PREVIEW_LINES} more lines` },
  ];
}

function fitLine(value, width) {
  const characters = Array.from(String(value));
  if (characters.length <= width) return characters.join("");
  if (width <= 1) return "…".slice(0, width);
  return characters.slice(0, width - 1).join("") + "…";
}

function HighlightedLine({ row, language, lineNumber, width, colors }) {
  const prefix = row.type === "delete" ? "-" : row.type === "add" ? "+" : " ";
  const prefixColor = row.type === "delete" ? colors.deleted : row.type === "add" ? colors.added : colors.muted;
  const text = fitLine(row.text, Math.max(1, width - 3));
  const parts = tokenizeLine(text, language, colors);
  const padding = " ".repeat(Math.max(0, width - Array.from(text).length - 2));

  return h(Box, { key: lineNumber, width },
    h(Text, { backgroundColor: colors.background },
      " ",
      h(Text, { color: prefixColor }, prefix),
      ...parts.map((part, index) => h(Text, { key: `${lineNumber}-${index}`, color: part.color }, part.text)),
      padding,
    )
  );
}

function MetaLine({ text, color, width, background }) {
  const content = fitLine(` ${text}`, Math.max(1, width));
  return h(Text, { color, backgroundColor: background }, content.padEnd(width));
}

function SyntaxPanel({ title, language, rows }) {
  const { stdout } = useStdout();
  const theme = useTheme();
  const colors = theme.colorEnabled ? {
    ...COLORS,
    background: theme.codeBackground,
    text: theme.assistant,
    muted: theme.muted,
    deleted: theme.error,
    added: theme.success,
    hunk: theme.info,
  } : Object.fromEntries(Object.keys(COLORS).map(key => [key, undefined]));
  const width = Math.max(16, (stdout?.columns || 80) - 2);
  const heading = fitLine(` ${title}  ·  ${language}`, width);
  return h(Box, {
    flexDirection: "column",
    width,
  },
    h(Text, { bold: true, color: colors.text, backgroundColor: colors.background }, heading.padEnd(width)),
    h(Box, { flexDirection: "column" },
    ...limitRows(rows).map((row, index) => {
      if (row.type === "meta-delete") return h(MetaLine, { key: index, text: row.text, color: colors.deleted, background: colors.background, width });
      if (row.type === "meta-add") return h(MetaLine, { key: index, text: row.text, color: colors.added, background: colors.background, width });
      if (row.type === "hunk") return h(MetaLine, { key: index, text: row.text, color: colors.hunk, background: colors.background, width });
      if (row.type === "omitted") return h(MetaLine, { key: index, text: row.text, color: colors.muted, background: colors.background, width });
      return h(HighlightedLine, { key: index, row, language, lineNumber: index, width, colors });
    }))
  );
}

export function MarkdownCodeBlock({ content, language }) {
  const resolvedLanguage = resolveLanguage(language);
  const rows = String(content).split("\n").map(text => ({ type: "context", text }));
  return h(SyntaxPanel, {
    title: "Code",
    language: resolvedLanguage,
    rows,
  });
}

export function CodePreview({ tool, args }) {
  const path = String(args?.path || "untitled");
  const language = languageForPath(path);
  const isEdit = tool === "edit";
  const rows = isEdit
    ? [
        { type: "meta-delete", text: `--- ${path}` },
        { type: "meta-add", text: `+++ ${path}` },
        { type: "hunk", text: "@@" },
        ...collapseContext(lineDiff(args?.oldString ?? "", args?.newString ?? "")),
      ]
    : String(args?.content ?? "").split("\n").map(text => ({ type: "context", text }));

  return h(SyntaxPanel, {
    title: `${isEdit ? "Edit" : "Write"}  ${path}`,
    language,
    rows,
  });
}
