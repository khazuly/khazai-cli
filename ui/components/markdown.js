import { createElement as h, useMemo } from "react";
import { Box, Text, useStdout } from "ink";
import { marked } from "marked";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { MarkdownCodeBlock } from "./code-preview.js";
import { useTheme } from "../theme.js";
import { normalizeVerticalWhitespace } from "../text-layout.js";
import { PrefixRow } from "./surface.js";

const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const LABEL_PATTERN = /^(Changed files|What changed|Verification|Root cause):/i;
const SEMANTIC_PATTERN = /(\d+(?:\.\d+)?)|(\b(?:passed|failed|failures|warning|error|completed)\b)|(\/?[\w.-]+\/[\w./-]+)/gi;
const STATUS_COLORS = {
  passed: "success",
  failed: "error",
  failures: "error",
  warning: "warning",
  error: "error",
  completed: "success",
};

function visibleText(value) {
  return String(value ?? "").replace(ANSI_PATTERN, "").replace(/[ \t]*\n[ \t]*/g, "\n");
}

function semanticText(text, theme, key) {
  if (!text || theme.colorEnabled === false) return text;
  const label = text.match(LABEL_PATTERN);
  if (label) {
    const remainder = text.slice(label[0].length);
    return [
      h(Text, { key: `${key}-label`, color: theme.secondary, bold: true }, label[0]),
      ...[].concat(remainder ? semanticText(remainder, theme, `${key}-after`) : []),
    ];
  }

  const segments = [];
  let cursor = 0;
  let match;
  SEMANTIC_PATTERN.lastIndex = 0;
  while ((match = SEMANTIC_PATTERN.exec(text)) !== null) {
    if (match.index > cursor) segments.push(text.slice(cursor, match.index));
    if (match[1]) {
      segments.push(h(Text, {
        key: `${key}-number-${segments.length}`,
        color: theme.syntax?.number,
      }, match[1]));
    } else if (match[2]) {
      const tone = STATUS_COLORS[match[2].toLowerCase()] || "info";
      segments.push(h(Text, {
        key: `${key}-status-${segments.length}`,
        color: theme[tone],
        bold: true,
      }, match[2]));
    } else {
      segments.push(h(Text, {
        key: `${key}-path-${segments.length}`,
        color: theme.syntax?.string,
      }, match[3]));
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) segments.push(text.slice(cursor));
  return segments.length ? segments : text;
}

function inline(tokens = [], theme, key = "inline") {
  return tokens.flatMap((token, index) => {
    const id = `${key}-${index}`;
    if (token.type === "strong") {
      return h(Text, { key: id, bold: true }, ...inline(token.tokens, theme, id));
    }
    if (token.type === "em") {
      return h(Text, { key: id, italic: true }, ...inline(token.tokens, theme, id));
    }
    if (token.type === "codespan") {
      return h(Text, { key: id, color: theme.secondary }, visibleText(token.text));
    }
    if (token.type === "del") {
      return h(Text, { key: id, strikethrough: true }, ...inline(token.tokens, theme, id));
    }
    if (token.type === "link") {
      const label = token.tokens?.length
        ? inline(token.tokens, theme, id)
        : visibleText(token.text);
      const href = visibleText(token.href);
      return h(Text, { key: id, color: theme.primary, underline: true },
        ...[].concat(label),
        visibleText(token.text) === href ? "" : ` (${href})`,
      );
    }
    if (token.type === "br") return "\n";
    if (token.tokens) return inline(token.tokens, theme, id);
    return semanticText(visibleText(token.raw ?? token.text), theme, id);
  });
}

function Paragraph({ token, tokenKey, width, theme }) {
  const tokens = token.tokens?.length
    ? token.tokens
    : [{ type: "text", raw: token.text ?? token.raw ?? "" }];
  return h(Box, { width, flexDirection: "column" },
    h(Text, { color: theme.text, wrap: "wrap" }, ...inline(tokens, theme, tokenKey)),
  );
}

function List({ token, width, theme, tokenKey }) {
  const markers = token.items.map((item, index) => {
    if (!token.ordered) return "•";
    return /^(\d+[.)])/.exec(item.raw || "")?.[1] || `${Number(token.start || 1) + index}.`;
  });
  const prefixWidth = Math.max(2, ...markers.map(marker => stringWidth(marker) + 1));
  const contentWidth = Math.max(8, width - prefixWidth);
  return h(Box, { flexDirection: "column", width },
    ...token.items.map((item, index) =>
      h(PrefixRow, {
        key: `${tokenKey}-item-${index}`,
        prefix: markers[index],
        prefixWidth,
        prefixColor: theme.subtle,
      },
        h(Box, { flexDirection: "column", width: contentWidth },
          ...(item.tokens || []).map((child, childIndex) =>
            renderToken(child, `${tokenKey}-item-${index}-${childIndex}`, contentWidth, theme),
          ),
        ),
      ),
    ),
  );
}

function Table({ token, width, theme }) {
  const header = token.header || [];
  const rows = token.rows || [];
  if (width < 60) {
    return h(Box, { flexDirection: "column", width },
      ...rows.flatMap((row, rowIndex) => row.map((cell, cellIndex) =>
        h(Text, { key: `${rowIndex}-${cellIndex}`, wrap: "wrap" },
          h(Text, { color: theme.metadata },
            `${visibleText(header[cellIndex]?.text || `Column ${cellIndex + 1}`)}: `,
          ),
          ...inline(cell.tokens || [{ raw: cell.text }], theme, `cell-${rowIndex}-${cellIndex}`),
        ),
      )),
    );
  }

  const columns = Math.max(1, header.length);
  const columnWidth = Math.max(8, Math.floor((width - columns - 3) / columns));
  const rowText = cells => cells.map(cell => {
    const text = visibleText(cell.text);
    const wrapped = wrapAnsi(text, columnWidth, { hard: true, trim: false }).split("\n")[0];
    return wrapped + " ".repeat(Math.max(0, columnWidth - stringWidth(wrapped)));
  }).join(" │ ");
  return h(Box, { flexDirection: "column", width },
    h(Text, { bold: true, color: theme.assistant }, rowText(header)),
    h(Text, { color: theme.border }, "─".repeat(Math.min(width, (columnWidth + 3) * columns))),
    ...rows.map((row, index) =>
      h(Text, { key: index, color: theme.text }, rowText(row)),
    ),
  );
}

function renderToken(token, key, width, theme) {
  if (!token || token.type === "space" || token.type === "hr") return null;
  if (token.type === "code") {
    const innerWidth = Math.max(8, width - 2);
    return h(Box, { key, width, paddingX: 1 },
      h(MarkdownCodeBlock, {
        content: token.text,
        language: token.lang,
        width: innerWidth,
      }),
    );
  }
  if (token.type === "heading") {
    return h(Box, { key, width },
      h(Text, {
        bold: true,
        color: token.depth <= 1 ? theme.primary : theme.secondary,
        wrap: "wrap",
      }, ...inline(token.tokens, theme, key)),
    );
  }
  if (token.type === "list") {
    return h(List, { key, token, width, theme, tokenKey: key });
  }
  if (token.type === "blockquote") {
    const contentWidth = Math.max(8, width - 2);
    return h(Box, {
      key,
      width,
      borderStyle: "single",
      borderTop: false,
      borderBottom: false,
      borderRight: false,
      paddingLeft: 1,
    },
      h(Box, { flexDirection: "column", width: contentWidth },
        ...token.tokens.map((child, index) =>
          renderToken(child, `${key}-${index}`, contentWidth, theme),
        ),
      ),
    );
  }
  if (token.type === "table") return h(Table, { key, token, width, theme });
  if (token.type === "paragraph" || token.type === "text") {
    return h(Paragraph, { key, token, tokenKey: key, width, theme });
  }
  if (token.tokens) {
    return h(Box, { key, flexDirection: "column", width },
      ...token.tokens.map((child, index) =>
        renderToken(child, `${key}-${index}`, width, theme),
      ),
    );
  }
  return h(Box, { key, width },
    h(Text, { wrap: "wrap" }, visibleText(token.raw || token.text)),
  );
}

export function Markdown({ content }) {
  const { stdout } = useStdout();
  const theme = useTheme();
  const width = Math.max(16, Number(stdout?.columns) || 80);
  const visible = useMemo(() => {
    const normalized = normalizeVerticalWhitespace(content || "");
    try {
      return marked.lexer(normalized, { gfm: true, breaks: false })
        .filter(token => token.type !== "space");
    } catch {
      return [{ type: "paragraph", tokens: [{ type: "text", raw: normalized }] }];
    }
  }, [content]);

  return h(Box, { flexDirection: "column", width: "100%" },
    ...visible.map((token, index) =>
      h(Box, {
        key: `${token.type}-${index}`,
        flexDirection: "column",
        width: "100%",
        marginBottom: index === visible.length - 1 ? 0 : 1,
      }, renderToken(token, `token-${index}`, width, theme)),
    ),
  );
}
