import { createElement as h } from "react";
import { Text, Box } from "ink";
import { ToolCall } from "./tool-call.js";
import { Thinking } from "./thinking.js";
import { CodePreview, MarkdownCodeBlock } from "./code-preview.js";

function truncateResult(text, maxLines = 4) {
  if (!text) return null;
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join("\n") + `\n  ... (${lines.length - maxLines} more)`;
}

function hasCodePreview(message) {
  if (!message.done) return false;
  if (message.tool === "write") return /^Written \d+ bytes to /.test(message.content || "");
  if (message.tool === "edit") return /^Edited /.test(message.content || "");
  return false;
}

function renderInline(text, keyPrefix) {
  const tokens = text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g);

  return tokens.filter(Boolean).map((token, index) => {
    const key = `${keyPrefix}-${index}`;
    if (token.startsWith("**") && token.endsWith("**")) {
      return h(Text, { key, bold: true, color: "yellow" }, token.slice(2, -2));
    }
    if (token.startsWith("`") && token.endsWith("`")) {
      return h(Text, { key, color: "cyan" }, token.slice(1, -1));
    }
    return token;
  });
}

function renderTextLine(line, key) {
  const heading = /^(#{1,6})\s+(.+)$/.exec(line);
  const bullet = /^(\s*)[-*]\s+(.+)$/.exec(line);

  if (heading) {
    return h(Text, { key, wrap: "wrap" }, ...renderInline(heading[2], key));
  }
  if (bullet) {
    return h(Text, { key, wrap: "wrap" },
      bullet[1],
      h(Text, { color: "yellow" }, "• "),
      ...renderInline(bullet[2], key)
    );
  }
  return h(Text, { key, wrap: "wrap" }, ...(line ? renderInline(line, key) : [" "]));
}

function answerBlocks(content) {
  const blocks = [];
  let text = [];
  let code = null;

  const flushText = () => {
    if (text.length) blocks.push({ type: "text", lines: text });
    text = [];
  };

  for (const line of content.split("\n")) {
    if (code) {
      if (/^`{1,3}\s*$/.test(line)) {
        blocks.push({ type: "code", language: code.language, content: code.lines.join("\n") });
        code = null;
      } else {
        code.lines.push(line);
      }
      continue;
    }

    const openingFence = /^```\s*([A-Za-z0-9_+.-]+)?\s*$/.exec(line);
    if (openingFence) {
      flushText();
      code = { language: openingFence[1] || "plain", lines: [] };
      continue;
    }
    text.push(line);
  }

  if (code) blocks.push({ type: "code", language: code.language, content: code.lines.join("\n") });
  flushText();
  return blocks;
}

function FormattedAnswer({ content, compact }) {
  const children = [];
  for (const [blockIndex, block] of answerBlocks(content).entries()) {
    if (block.type === "code") {
      children.push(h(Box, { key: `code-${blockIndex}`, marginTop: 1, marginBottom: 1 },
        h(MarkdownCodeBlock, { content: block.content, language: block.language })
      ));
      continue;
    }
    block.lines.forEach((line, lineIndex) => {
      children.push(renderTextLine(line, `text-${blockIndex}-${lineIndex}`));
    });
  }
  return h(Box, { flexDirection: "column", paddingRight: 2, width: "100%" }, ...children);
}

function ErrorDisplay({ content }) {
  const lines = (content || "").split("\n");
  const mainError = lines[0] || "Unknown error";
  const details = lines.slice(1).join("\n");

  return h(Box, {
    flexDirection: "column",
    borderStyle: "round",
    borderColor: "red",
    paddingLeft: 1,
    paddingRight: 1,
    marginTop: 1,
    marginBottom: 1,
  },
    h(Text, { color: "red", bold: true }, "✗ ", mainError),
    details ? h(Text, { dimColor: true }, details) : null
  );
}

function ToolResultDisplay({ message }) {
  const content = message.content || "";
  const lines = content.split("\n");
  const exitMatch = /^Exit:\s*(-?\d+)/.exec(lines[0]);
  const exitCode = exitMatch ? parseInt(exitMatch[1]) : 0;
  const isSuccess = exitCode === 0;

  return h(Box, { marginLeft: 3 },
    h(Text, { dimColor: true }, truncateResult(content))
  );
}

export function MessageList({ messages, previousType = null }) {
  const items = messages.map((m, index) => {
    switch (m.type) {
      case "user":
        return h(Box, { key: m.id, flexDirection: "column" },
          h(Box, {},
            h(Text, { bold: true, color: "yellow" }, "❯ "),
            h(Text, {}, m.content)
          ),
          h(Text, { dimColor: true }, "  ╰─")
        );
      case "thinking":
        return h(Box, { key: m.id, marginLeft: 2 }, h(Thinking));
      case "tool":
        return h(Box, { key: m.id, marginLeft: 2, flexDirection: "column" },
          h(ToolCall, { tool: m.tool, args: m.args, done: m.done, duration: m.duration, resultSize: m.resultSize }),
          m.done && m.content
            ? hasCodePreview(m)
              ? h(Box, { marginLeft: 3, marginTop: 1 }, h(CodePreview, { tool: m.tool, args: m.args }))
              : h(ToolResultDisplay, { message: m })
            : null
        );
      case "answer":
        return h(Box, {
          key: m.id,
          marginLeft: 1,
          marginRight: 1,
          marginTop: (index === 0 ? previousType : messages[index - 1]?.type) === "tool" ? 1 : 0,
          marginBottom: 1,
        },
          h(FormattedAnswer, { content: m.content, compact: m.compact })
        );
      case "streaming":
        return h(Box, {
          key: m.id,
          marginLeft: 1,
          marginRight: 1,
          marginTop: previousType === "tool" ? 1 : 0,
        },
          h(FormattedAnswer, { content: m.content }),
          h(Text, { color: "gray" }, "...")
        );
      case "error":
        return h(ErrorDisplay, { key: m.id, content: m.content });
      default:
        return null;
    }
  }).filter(Boolean);

  return h(Box, { flexDirection: "column" }, ...items);
}
