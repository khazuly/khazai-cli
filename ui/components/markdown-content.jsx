import React from "react";
import { marked } from "marked";
import { highlightBlock, resolveLanguage } from "../../lib/syntax-highlighter.js";
import { syntaxThemeColors } from "../syntax-theme.js";
import { CODEX_UI as UI_COLORS } from "../palette.js";

function inline(tokens = [], key = "inline") {
  return tokens.flatMap((token, index) => {
    const id = `${key}-${index}`;
    if (token.type === "strong") return <b key={id}>{inline(token.tokens, id)}</b>;
    if (token.type === "em") return <i key={id}>{inline(token.tokens, id)}</i>;
    if (token.type === "codespan") return <span key={id} fg="#b7a0d8">{token.text}</span>;
    if (token.type === "del") return <span key={id} fg={UI_COLORS.muted}>{inline(token.tokens, id)}</span>;
    if (token.type === "link") return <u key={id}>{inline(token.tokens || [{ raw: token.text }], id)}</u>;
    if (token.type === "br") return "\n";
    if (token.tokens) return inline(token.tokens, id);
    return token.raw ?? token.text ?? "";
  });
}

function CodeBlock({ token, theme }) {
  const colors = syntaxThemeColors(theme);
  const language = resolveLanguage(token.lang);
  return <box flexDirection="column" marginTop={1} marginBottom={1} paddingLeft={1} borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} borderColor={UI_COLORS.border}>
    {token.lang ? <text fg={UI_COLORS.muted}>{token.lang}</text> : null}
    {highlightBlock(token.text || "", language).map((line, lineIndex) => <text key={lineIndex} wrapMode="char">
      {line.map((part, partIndex) => <span key={partIndex} fg={colors[part.color] || colors.text}>{part.text}</span>)}
    </text>)}
  </box>;
}

function ListBlock({ token, theme, depth = 0 }) {
  return <box flexDirection="column" paddingLeft={Math.min(depth * 2, 6)}>
    {token.items.map((item, index) => <box key={index} flexDirection="row">
      <text fg={UI_COLORS.muted}>{token.ordered ? `${Number(token.start || 1) + index}.` : "•"} </text>
      <box flexDirection="column" flexGrow={1}>
        {(item.tokens || []).map((child, childIndex) => <TokenBlock key={childIndex} token={child} theme={theme} depth={depth + 1} />)}
      </box>
    </box>)}
  </box>;
}

function TableBlock({ token }) {
  const headers = token.header || [];
  return <box flexDirection="column" marginTop={1} marginBottom={1}>
    {(token.rows || []).flatMap((row, rowIndex) => row.map((cell, cellIndex) => <text key={`${rowIndex}-${cellIndex}`}>
      <span fg={UI_COLORS.muted}>{headers[cellIndex]?.text || `Column ${cellIndex + 1}`}: </span>
      {inline(cell.tokens || [{ raw: cell.text }], `cell-${rowIndex}-${cellIndex}`)}
    </text>))}
  </box>;
}

function TokenBlock({ token, theme, depth = 0 }) {
  if (!token || token.type === "space") return null;
  if (token.type === "code") return <CodeBlock token={token} theme={theme} />;
  if (token.type === "heading") return <text><b>{inline(token.tokens, "heading")}</b></text>;
  if (token.type === "list") return <ListBlock token={token} theme={theme} depth={depth} />;
  if (token.type === "blockquote") {
    return <box flexDirection="column" paddingLeft={1} borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} borderColor={UI_COLORS.border}>
      {token.tokens.map((child, index) => <TokenBlock key={index} token={child} theme={theme} depth={depth} />)}
    </box>;
  }
  if (token.type === "table") return <TableBlock token={token} />;
  if (token.type === "hr") return <text fg={UI_COLORS.muted}>────────────────────────</text>;
  if (token.type === "paragraph" || token.type === "text") return <text wrapMode="word">{inline(token.tokens || [{ raw: token.text }], token.type)}</text>;
  if (token.tokens) {
    return <box flexDirection="column">{token.tokens.map((child, index) => <TokenBlock key={index} token={child} theme={theme} depth={depth} />)}</box>;
  }
  return <text>{token.raw || token.text || ""}</text>;
}

export function MarkdownContent({ content, theme = "catppuccin-mocha" }) {
  let tokens;
  try {
    tokens = marked.lexer(String(content || ""), { gfm: true, breaks: false });
  } catch {
    tokens = [{ type: "paragraph", tokens: [{ raw: String(content || "") }] }];
  }
  const visible = tokens.filter(token => token.type !== "space");
  return <box width="100%" flexDirection="column">
    {visible.map((token, index) => <box key={index} flexDirection="column" marginBottom={index === visible.length - 1 ? 0 : 1}>
      <TokenBlock token={token} theme={theme} />
    </box>)}
  </box>;
}
