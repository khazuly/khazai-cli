import { createElement as h } from "react";
import { Box, Text, useStdout } from "ink";
import { marked } from "marked";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { MarkdownCodeBlock } from "./code-preview.js";
import { useTheme } from "../theme.js";

function inline(tokens = [], theme, key = "inline") {
  return tokens.flatMap((token, index) => {
    const id = `${key}-${index}`;
    if (token.type === "strong") return h(Text, { key: id, bold: true }, ...inline(token.tokens, theme, id));
    if (token.type === "em") return h(Text, { key: id, italic: true }, ...inline(token.tokens, theme, id));
    if (token.type === "codespan") return h(Text, { key: id, color: theme?.secondary }, token.text);
    if (token.type === "del") return h(Text, { key: id, strikethrough: true }, ...inline(token.tokens, theme, id));
    if (token.type === "link") {
      const label = token.tokens?.length ? inline(token.tokens, theme, id) : token.text;
      return h(Text, { key: id, color: theme?.info, underline: true }, ...[].concat(label), token.text === token.href ? "" : ` (${token.href})`);
    }
    if (token.type === "br") return "\n";
    if (token.tokens) return inline(token.tokens, theme, id);
    return token.raw ?? token.text ?? "";
  });
}

function List({ token, depth = 0 }) {
  const theme = useTheme();
  return h(Box, { flexDirection: "column", marginLeft: Math.min(depth * 2, 6) },
    ...token.items.map((item, index) => {
      const marker = token.ordered ? `${Number(token.start || 1) + index}.` : "•";
      const body = item.tokens || [];
      const first = body[0];
      const rest = body.slice(1);
      return h(Box, { key: `item-${depth}-${index}`, flexDirection: "column" },
        h(Box, { alignItems: "flex-start" },
          h(Box, { width: Math.max(2, stringWidth(marker) + 1), flexShrink: 0 },
            h(Text, { color: theme.metadata }, `${marker} `),
          ),
          h(Box, { flexDirection: "column", flexGrow: 1, flexShrink: 1 },
            first ? renderToken(first, `first-${index}`, depth + 1) : null,
          ),
        ),
        ...rest.map((child, childIndex) => renderToken(child, `child-${index}-${childIndex}`, depth + 1)),
      );
    }),
  );
}

function Table({ token }) {
  const { stdout } = useStdout();
  const theme = useTheme();
  const width = Number(stdout?.columns) || 80;
  const header = token.header || [];
  const rows = token.rows || [];
  if (width < 60) {
    return h(Box, { flexDirection: "column", marginBottom: 1 },
      ...rows.flatMap((row, rowIndex) => row.map((cell, cellIndex) =>
        h(Text, { key: `${rowIndex}-${cellIndex}`, wrap: "wrap" },
          h(Text, { color: theme.metadata }, `${header[cellIndex]?.text || `Column ${cellIndex + 1}`}: `),
          ...inline(cell.tokens || [{ raw: cell.text }], theme, `cell-${rowIndex}-${cellIndex}`),
        )
      )),
    );
  }
  const columns = Math.max(1, header.length);
  const columnWidth = Math.max(8, Math.floor((width - columns - 3) / columns));
  const rowText = cells => cells.map(cell => {
    const text = String(cell.text || "");
    const wrapped = wrapAnsi(text, columnWidth, { hard: true, trim: false }).split("\n")[0];
    return wrapped + " ".repeat(Math.max(0, columnWidth - stringWidth(wrapped)));
  }).join(" │ ");
  return h(Box, { flexDirection: "column", marginBottom: 1 },
    h(Text, { bold: true, color: theme.assistant }, rowText(header)),
    h(Text, { color: theme.border }, "─".repeat(Math.min(width - 2, (columnWidth + 3) * columns))),
    ...rows.map((row, index) => h(Text, { key: index, color: theme.text }, rowText(row))),
  );
}

function renderToken(token, key, depth = 0) {
  if (!token) return null;
  if (token.type === "space") return h(Text, { key }, " ");
  if (token.type === "code") return h(Box, { key, marginY: 1 }, h(MarkdownCodeBlock, { content: token.text, language: token.lang }));
  if (token.type === "heading") {
    return h(Text, { key, bold: true, wrap: "wrap" }, ...inline(token.tokens, null, key));
  }
  if (token.type === "list") return h(List, { key, token, depth });
  if (token.type === "blockquote") {
    return h(Box, { key, borderStyle: "single", borderTop: false, borderBottom: false, borderRight: false, paddingLeft: 1, marginY: 1 },
      h(Box, { flexDirection: "column" }, ...token.tokens.map((child, index) => renderToken(child, `${key}-${index}`, depth))),
    );
  }
  if (token.type === "table") return h(Table, { key, token });
  if (token.type === "hr") return h(Text, { key, dimColor: true }, "─".repeat(24));
  if (token.type === "paragraph" || token.type === "text") {
    return h(Text, { key, wrap: "wrap" }, ...inline(token.tokens || [{ raw: token.text }], null, key));
  }
  return token.tokens
    ? h(Box, { key, flexDirection: "column" }, ...token.tokens.map((child, index) => renderToken(child, `${key}-${index}`, depth)))
    : h(Text, { key, wrap: "wrap" }, token.raw || token.text || "");
}

export function Markdown({ content }) {
  const theme = useTheme();
  let tokens;
  try {
    tokens = marked.lexer(String(content || ""), { gfm: true, breaks: false });
  } catch {
    tokens = [{ type: "paragraph", tokens: [{ raw: String(content || "") }] }];
  }
  const visible = tokens.filter(token => token.type !== "space");
  return h(Box, { flexDirection: "column", width: "100%" },
    ...visible.map((token, index) =>
      h(Box, { key: index, flexDirection: "column", marginBottom: index === visible.length - 1 ? 0 : 1, color: theme.assistant },
        renderToken(token, `token-${index}`),
      )
    ),
  );
}
