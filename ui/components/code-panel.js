import { createElement as h } from "react";
import { Box, Text, useStdout } from "ink";
import stringWidth from "string-width";
import { highlightLine } from "../../lib/syntax-highlighter.js";
import { useTheme } from "../theme.js";

export const GITHUB_DARK = {
  text: "#c9d1d9",
  muted: "#8b949e",
  comment: "#8b949e",
  keyword: "#ff7b72",
  type: "#ffa657",
  function: "#d2a8ff",
  string: "#a5d6ff",
  number: "#79c0ff",
  property: "#79c0ff",
  operator: "#ff7b72",
  tag: "#7ee787",
  added: "#7ee787",
  deleted: "#ffa198",
  hunk: "#79c0ff",
};

function fit(value, width) {
  const source = String(value || "");
  if (stringWidth(source) <= width) return source;
  let result = "";
  for (const character of Array.from(source)) {
    if (stringWidth(result) + stringWidth(character) > Math.max(0, width - 1)) break;
    result += character;
  }
  return `${result}…`;
}

function truncateParts(parts, width) {
  const result = [];
  let used = 0;
  for (const part of parts) {
    const available = width - used;
    if (available <= 0) break;
    const text = fit(part.text, available);
    result.push({ ...part, text });
    used += stringWidth(text);
    if (text.endsWith("…")) break;
  }
  return result;
}

function rowNumbers(rows) {
  return rows.map(row => {
    if (!["context", "add", "delete"].includes(row.type)) return row;
    return row;
  });
}

function marker(type) {
  if (type === "add") return "+";
  if (type === "delete") return "−";
  return " ";
}

function colorForRow(type, colors) {
  if (type === "add" || type === "meta-add") return colors.added;
  if (type === "delete" || type === "meta-delete") return colors.deleted;
  if (type === "hunk") return colors.hunk;
  return colors.muted;
}

function codeGutter(row, gutterWidth, diffGutter) {
  if (!diffGutter) {
    const lineNumber = String(row.newLine || row.oldLine || "");
    return lineNumber.padStart(gutterWidth);
  }
  const oldLine = row.type === "add" ? "" : String(row.oldLine || "");
  const newLine = row.type === "delete" ? "" : String(row.newLine || "");
  return `${oldLine.padStart(gutterWidth)} ${newLine.padStart(gutterWidth)}`;
}

function CodeRow({ row, language, gutterWidth, codeWidth, colors, colorEnabled, diffGutter }) {
  if (!["context", "add", "delete"].includes(row.type)) {
    const text = fit(row.text, gutterWidth + 2 + codeWidth);
    return h(Text, { color: colorForRow(row.type, colors) }, ` ${text}`);
  }
  const parts = colorEnabled ? highlightLine(row.text, language) : [{ text: row.text, color: "text" }];
  const visible = truncateParts(parts, codeWidth);
  return h(Box, null,
      h(Text, { color: colors.muted }, `${codeGutter(row, gutterWidth, diffGutter)} `),
      h(Text, { color: colorForRow(row.type, colors) }, `${marker(row.type)} `),
      h(Text, null, ...visible.map((part, partIndex) => h(Text, {
        key: partIndex,
        color: colors[part.color] || colors.text,
      }, part.text))),
  );
}

export function CodePanel({ title, language, rows, maximumRows = 20 }) {
  const { stdout } = useStdout();
  const theme = useTheme();
  const colorEnabled = theme.colorEnabled;
  const colors = colorEnabled ? GITHUB_DARK : Object.fromEntries(Object.keys(GITHUB_DARK).map(key => [key, undefined]));
  const width = Math.max(16, stdout?.columns || 80);
  const numbered = rowNumbers(rows);
  const visible = numbered.length > maximumRows
    ? [...numbered.slice(0, maximumRows), { type: "omitted", text: `… ${numbered.length - maximumRows} more lines` }]
    : numbered;
  const largest = Math.max(1, ...numbered.flatMap(row => [Number(row.oldLine) || 0, Number(row.newLine) || 0]));
  const gutterWidth = String(largest).length;
  const diffGutter = numbered.some(row => row.type === "add" || row.type === "delete");
  const codeWidth = Math.max(4, width - (diffGutter ? gutterWidth * 2 : gutterWidth) - 4);
  const heading = fit(title, width);

  return h(Box, { flexDirection: "column", width: "100%" },
    h(Text, { bold: true, color: colors.text }, heading),
    h(Box, { flexDirection: "column" }, ...visible.map((row, index) => h(CodeRow, {
      key: `${row.type}-${index}`,
      row,
      language,
      gutterWidth,
      codeWidth,
      colors,
      colorEnabled,
      diffGutter,
    }))),
  );
}
