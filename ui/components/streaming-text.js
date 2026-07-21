import { createElement as h } from "react";
import { Box, Text, useStdout } from "ink";
import { marked } from "marked";
import { MarkdownCodeBlock } from "./code-preview.js";
import { useTheme } from "../theme.js";

// Detect incomplete markdown constructs that would break the renderer.
function hasOpenCodeFence(text) {
  const fences = text.match(/^```/gm);
  return fences && fences.length % 2 !== 0;
}

function stripIncompleteMarkdown(text) {
  let result = text;
  // If there's an open code fence, remove everything from the last opening fence
  // onward. The fence itself stays so the user can see the language hint.
  if (hasOpenCodeFence(text)) {
    const lastFence = result.lastIndexOf("\n```");
    if (lastFence >= 0) {
      result = result.slice(0, lastFence);
    }
  }
  // Strip trailing incomplete bold/italic markers to prevent rendering artifacts.
  result = result.replace(/\*{1,2}(?!\*)\s*$/, "");
  result = result.replace(/_(?!_)\s*$/, "");
  return result;
}

// Render markdown tokens into Ink elements, same as the full Markdown component
// but operating on potentially incomplete streaming content.
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

function renderToken(token, key, depth = 0) {
  if (!token) return null;
  if (token.type === "space") return h(Text, { key }, " ");
  if (token.type === "code") return h(Box, { key, marginY: 1 }, h(MarkdownCodeBlock, { content: token.text, language: token.lang }));
  if (token.type === "heading") {
    return h(Text, { key, bold: true, wrap: "wrap" }, ...inline(token.tokens, null, key));
  }
  if (token.type === "list") {
    return h(Box, { key, flexDirection: "column" },
      ...token.items.map((item, i) => h(Box, { key: `item-${i}`, flexDirection: "row" },
        h(Text, { color: null }, `${token.ordered ? `${(Number(token.start || 1) + i)}.` : "•"} `),
        h(Text, { wrap: "wrap" }, ...inline(item.tokens || [{ raw: item.text || "" }], null, `item-${i}`)),
      ))
    );
  }
  if (token.type === "blockquote") {
    return h(Box, { key, borderStyle: "single", borderTop: false, borderBottom: false, borderRight: false, paddingLeft: 1, marginY: 1 },
      h(Box, { flexDirection: "column" }, ...token.tokens.map((child, index) => renderToken(child, `${key}-${index}`, depth))),
    );
  }
  if (token.type === "hr") return h(Text, { key, dimColor: true }, "─".repeat(24));
  if (token.type === "paragraph" || token.type === "text") {
    return h(Text, { key, wrap: "wrap" }, ...inline(token.tokens || [{ raw: token.text }], null, key));
  }
  return token.tokens
    ? h(Box, { key, flexDirection: "column" }, ...token.tokens.map((child, index) => renderToken(child, `${key}-${index}`, depth)))
    : h(Text, { key, wrap: "wrap" }, token.raw || token.text || "");
}

// Limit visible rows by trimming the raw text source. This operates on the
// rendered source rather than the rendered Ink tree so it keeps the layout
// simple while still respecting terminal height.
function limitSourceRows(text, columns, maximumRows) {
  const source = String(text || "");
  if (!Number.isFinite(maximumRows)) return source;
  const width = Math.max(8, Math.trunc(Number(columns) || 80) - 1);
  const rowLimit = Math.max(1, Math.trunc(Number(maximumRows) || 1));
  const physicalRows = [];
  for (const line of source.split("\n")) {
    const characters = Array.from(line);
    if (characters.length === 0) {
      physicalRows.push("");
      continue;
    }
    for (let offset = 0; offset < characters.length; offset += width) {
      physicalRows.push(characters.slice(offset, offset + width).join(""));
    }
  }
  if (physicalRows.length <= rowLimit) return source;
  if (rowLimit === 1) {
    const tail = physicalRows.at(-1) || "";
    return `… ${tail}`.slice(0, width);
  }
  return ["…", ...physicalRows.slice(-(rowLimit - 1))].join("\n");
}

export function StreamingText({ content, columns, maximumRows = Infinity }) {
  const theme = useTheme();
  const raw = String(content || "");

  // Apply viewport limiting before rendering so we don't waste ink on text
  // the user cannot see.
  const limited = limitSourceRows(raw, columns, maximumRows);

  // Strip incomplete markdown constructs that would produce broken rendering.
  const clean = stripIncompleteMarkdown(limited);

  let tokens;
  try {
    tokens = marked.lexer(clean, { gfm: true, breaks: false });
  } catch {
    tokens = [{ type: "paragraph", tokens: [{ raw: clean }] }];
  }

  const visible = tokens.filter(token => token.type !== "space");
  const rendered = visible.map((token, index) =>
    h(Box, { key: index, flexDirection: "column", marginBottom: 1 },
      renderToken(token, `token-${index}`),
    )
  );

  return h(Box, { flexDirection: "column", width: "100%" },
    ...rendered,
    // Blinking cursor to indicate streaming state
    h(Text, { color: theme.metadata, dimColor: true }, "▋"),
  );
}
