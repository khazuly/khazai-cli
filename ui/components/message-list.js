import { createElement as h } from "react";
import { Text, Box, useStdout } from "ink";
import { ToolCall } from "./tool-call.js";
import { CodePreview, MarkdownCodeBlock } from "./code-preview.js";
import { normalizeVerticalWhitespace } from "../text-layout.js";
import { PASTEL } from "../palette.js";
import {
  GITHUB_DARK_BACKGROUND,
  GITHUB_DARK_TEXT,
  PANEL_HORIZONTAL_PADDING,
  PANEL_END,
  PANEL_SPACE,
  panelBlankLine,
  padPanelLine,
  wrapPanelText,
} from "../dark-panel.js";

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
      return h(Text, { key, bold: true }, token.slice(2, -2));
    }
    if (token.startsWith("`") && token.endsWith("`")) {
      return h(Text, { key, color: PASTEL.lavender }, token.slice(1, -1));
    }
    return token;
  });
}

function renderListLine(marker, content, key, marginLeft = 0) {
  const markerWidth = Array.from(marker).length;
  return h(Box, {
    key,
    flexShrink: 1,
    alignItems: "flex-start",
    marginLeft,
  },
    h(Box, { width: markerWidth, flexShrink: 0 },
      h(Text, { dimColor: true }, marker),
    ),
    h(Box, { flexGrow: 1, flexShrink: 1 },
      h(Text, { wrap: "wrap" }, ...renderInline(content, key)),
    ),
  );
}

function renderTextLine(line, key) {
  const heading = /^(#{1,6})\s+(.+)$/.exec(line);
  const numbered = /^\s*(\d+)[.)]\s+(.+)$/.exec(line);
  const bullet = /^(\s*)[-*]\s+(.+)$/.exec(line);
  if (heading) return h(Text, { key, bold: true, wrap: "wrap" }, ...renderInline(heading[2], key));
  if (numbered) return renderListLine(`${numbered[1]}. `, numbered[2], key);
  if (bullet) return renderListLine("- ", bullet[2], key, bullet[1].length > 0 ? 3 : 0);
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
      } else code.lines.push(line);
      continue;
    }
    const openingFence = /^```\s*([A-Za-z0-9_+.-]+)?\s*$/.exec(line);
    if (openingFence) {
      flushText();
      code = { language: openingFence[1] || "plain", lines: [] };
    } else text.push(line);
  }
  if (code) blocks.push({ type: "code", language: code.language, content: code.lines.join("\n") });
  flushText();
  return blocks;
}

function FormattedAnswer({ content }) {
  content = normalizeVerticalWhitespace(content || "");
  const children = [];
  for (const [blockIndex, block] of answerBlocks(content).entries()) {
    if (block.type === "code") {
      children.push(h(Box, { key: `code-${blockIndex}`, marginTop: 1, marginBottom: 1 },
        h(MarkdownCodeBlock, { content: block.content, language: block.language })
      ));
    } else {
      block.lines.forEach((line, lineIndex) => children.push(renderTextLine(line, `text-${blockIndex}-${lineIndex}`)));
    }
  }
  return h(Box, { flexDirection: "column", width: "100%" }, ...children);
}

function RoleMessage({ role, content }) {
  return h(Box, { flexDirection: "column", marginBottom: 1 },
    h(Text, { bold: true }, role),
    h(Box, { flexDirection: "column", marginTop: 1, width: "100%" },
      h(FormattedAnswer, { content }),
    )
  );
}

function UserMessage({ content }) {
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns || 80;
  const panelWidth = Math.max(12, terminalWidth);
  const sidePadding = PANEL_SPACE.repeat(PANEL_HORIZONTAL_PADDING);
  const innerWidth = Math.max(1, panelWidth - (PANEL_HORIZONTAL_PADDING * 2));
  const rows = wrapPanelText(content || "", innerWidth);
  return h(Box, {
    flexDirection: "column",
    width: panelWidth,
    marginBottom: 1,
    marginLeft: terminalWidth > panelWidth ? Math.floor((terminalWidth - panelWidth) / 2) : 0,
  },
    h(Text, { backgroundColor: GITHUB_DARK_BACKGROUND }, panelBlankLine(panelWidth)),
    h(Text, { bold: true, color: GITHUB_DARK_TEXT, backgroundColor: GITHUB_DARK_BACKGROUND },
      `${sidePadding}${padPanelLine("You", innerWidth)}${sidePadding}${PANEL_END}`,
    ),
    h(Text, { backgroundColor: GITHUB_DARK_BACKGROUND }, panelBlankLine(panelWidth)),
    ...rows.map((line, index) => h(Text, {
      key: `user-line-${index}`,
      color: GITHUB_DARK_TEXT,
      backgroundColor: GITHUB_DARK_BACKGROUND,
    }, `${sidePadding}${padPanelLine(line, innerWidth)}${sidePadding}${PANEL_END}`)),
    h(Text, { backgroundColor: GITHUB_DARK_BACKGROUND }, panelBlankLine(panelWidth)),
  );
}

function ErrorDisplay({ content }) {
  const lines = normalizeVerticalWhitespace(content || "Unknown error").split("\n");
  const suggestion = /syntax validation/i.test(content)
    ? "Review the reported location and rewrite the incomplete block."
    : /not found|does not exist/i.test(content)
      ? "Check the path or create the missing file first."
      : /timed? out/i.test(content)
        ? "Run the command manually or reduce the operation scope."
        : null;
  return h(Box, { flexDirection: "column", marginBottom: 1 },
    h(Text, { color: PASTEL.rose, bold: true }, "Error"),
    h(Box, { flexDirection: "column", marginTop: 1 },
      ...lines.map((line, index) => h(Text, { key: index, dimColor: index > 0, wrap: "wrap" }, line)),
      suggestion ? h(Text, { dimColor: true, wrap: "wrap" }, `Next  ${suggestion}`) : null,
    )
  );
}

function SummaryDisplay({ message }) {
  const details = [];
  if (message.created) details.push(`${message.created} created`);
  if (message.updated) details.push(`${message.updated} updated`);
  if (message.tests) details.push(`${message.tests} tests passed`);
  details.push(`${message.tools} ${message.tools === 1 ? "tool" : "tools"}`);
  details.push(message.duration < 1000 ? `${message.duration} ms` : `${(message.duration / 1000).toFixed(1)} s`);
  return h(Box, { marginBottom: 1 },
    h(Text, { bold: true }, "Completed"),
    h(Text, { dimColor: true }, "  ", details.join(" · "))
  );
}

export function MessageList({ messages }) {
  const items = messages.map(m => {
    switch (m.type) {
      case "user":
        return h(UserMessage, { key: m.id, content: m.content });
      case "tool":
        return h(Box, { key: m.id, flexDirection: "column" },
          h(ToolCall, {
            tool: m.tool, args: m.args, done: m.done, duration: m.duration,
            resultSize: m.resultSize, content: m.content, expanded: m.expanded,
          }),
          hasCodePreview(m)
            ? h(Box, { marginLeft: 1, marginRight: 1, marginBottom: 1 },
                h(CodePreview, { tool: m.tool, args: m.args })
              )
            : null,
        );
      case "answer":
        return h(RoleMessage, { key: m.id, role: "KhazAI", content: m.content });
      case "streaming":
        return h(RoleMessage, { key: m.id, role: "KhazAI", content: m.content });
      case "error":
        return h(ErrorDisplay, { key: m.id, content: m.content });
      case "summary":
        return h(SummaryDisplay, { key: m.id, message: m });
      default:
        return null;
    }
  }).filter(Boolean);

  return h(Box, {
    flexDirection: "column",
    justifyContent: "flex-start",
    flexGrow: 0,
    flexShrink: 0,
  }, ...items);
}
