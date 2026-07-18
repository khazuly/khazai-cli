import { createElement as h } from "react";
import { Text, Box, useStdout } from "ink";
import { ToolCall } from "./tool-call.js";
import { CodePreview, MarkdownCodeBlock } from "./code-preview.js";
import { Markdown } from "./markdown.js";
import { normalizeVerticalWhitespace } from "../text-layout.js";
import { useTheme } from "../theme.js";
import {
  PANEL_HORIZONTAL_PADDING,
  PANEL_END,
  PANEL_SPACE,
  padPanelLine,
  wrapPanelText,
} from "../dark-panel.js";

function hasCodePreview(message) {
  if (!message.done) return false;
  if (message.tool === "write") return /^Written \d+ bytes to /.test(message.content || "");
  if (message.tool === "edit") return /^Edited /.test(message.content || "");
  return false;
}

function renderInline(text, keyPrefix, theme) {
  const tokens = text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g);
  return tokens.filter(Boolean).map((token, index) => {
    const key = `${keyPrefix}-${index}`;
    if (token.startsWith("**") && token.endsWith("**")) {
      return h(Text, { key, bold: true }, token.slice(2, -2));
    }
    if (token.startsWith("`") && token.endsWith("`")) {
      return h(Text, { key, color: theme.secondary }, token.slice(1, -1));
    }
    return token;
  });
}

function renderListLine(marker, content, key, theme, marginLeft = 0) {
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
      h(Text, { color: theme.assistant, wrap: "wrap" }, ...renderInline(content, key, theme)),
    ),
  );
}

function renderTextLine(line, key, theme) {
  const heading = /^(#{1,6})\s+(.+)$/.exec(line);
  const numbered = /^\s*(\d+)[.)]\s+(.+)$/.exec(line);
  const bullet = /^(\s*)[-*]\s+(.+)$/.exec(line);
  if (heading) return h(Text, { key, bold: true, color: theme.assistant, wrap: "wrap" }, ...renderInline(heading[2], key, theme));
  if (numbered) return renderListLine(`${numbered[1]}. `, numbered[2], key, theme);
  if (bullet) return renderListLine("- ", bullet[2], key, theme, bullet[1].length > 0 ? 3 : 0);
  return h(Text, { key, color: theme.assistant, wrap: "wrap" }, ...(line ? renderInline(line, key, theme) : [" "]));
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
  return h(Markdown, { content: normalizeVerticalWhitespace(content || "") });
}

function RoleMessage({ role, content }) {
  const theme = useTheme();
  return h(Box, { flexDirection: "column", marginBottom: 1 },
    h(Text, { bold: true, color: theme.primary }, role),
    h(Box, { flexDirection: "column", width: "100%" },
      h(FormattedAnswer, { content }),
    )
  );
}

function UserMessage({ content }) {
  const theme = useTheme();
  return h(Box, {
    borderStyle: "single",
    borderTop: false,
    borderBottom: false,
    borderRight: false,
    borderColor: theme.primary,
    paddingLeft: 1,
    marginBottom: 1,
  },
    h(Box, { flexDirection: "column" },
      h(Text, { bold: true, color: theme.primary }, "You"),
      h(Text, { color: theme.inputText, wrap: "wrap" }, content),
    ),
  );
}

function ErrorDisplay({ content }) {
  const theme = useTheme();
  const lines = normalizeVerticalWhitespace(content || "Unknown error").split("\n");
  const suggestion = /syntax validation/i.test(content)
    ? "Review the reported location and rewrite the incomplete block."
    : /not found|does not exist/i.test(content)
      ? "Check the path or create the missing file first."
      : /timed? out/i.test(content)
        ? "Run the command manually or reduce the operation scope."
        : null;
  return h(Box, { flexDirection: "column", marginBottom: 1 },
    h(Text, { color: theme.error, bold: true }, "Error"),
    h(Box, { flexDirection: "column", marginTop: 1 },
      ...lines.map((line, index) => h(Text, { key: index, dimColor: index > 0, wrap: "wrap" }, line)),
      suggestion ? h(Text, { dimColor: true, wrap: "wrap" }, `Next  ${suggestion}`) : null,
    )
  );
}

function SummaryDisplay({ message }) {
  const theme = useTheme();
  const duration = message.duration < 1000 ? `${message.duration} ms` : `${(message.duration / 1000).toFixed(1)} s`;
  const headline = message.status === "attention" ? "Finished with issues" : "Finished";
  const details = [`${message.tools} ${message.tools === 1 ? "tool" : "tools"}`, duration];
  const files = Array.isArray(message.files) ? message.files : [];
  const validations = Array.isArray(message.validations) ? message.validations.slice(0, 3) : [];
  return h(Box, { flexDirection: "column", marginBottom: 1, paddingLeft: 1 },
    h(Box, null,
      h(Text, { bold: true, color: message.status === "attention" ? theme.warning : theme.success }, headline),
      h(Text, { color: theme.metadata }, "  ", details.join(" · ")),
    ),
    files.length
      ? h(Text, { color: theme.toolTarget, wrap: "wrap" }, `Files  ${files.slice(0, 3).join(" · ")}${files.length > 3 ? ` · +${files.length - 3}` : ""}`)
      : null,
    ...validations.map((validation, index) => h(Text, {
      key: `validation-${index}`,
      color: validation.exitCode === 0 ? theme.success : theme.error,
      wrap: "wrap",
    }, `Check  ${String(validation.command).replace(/\s+/g, " ").slice(0, 120)}${String(validation.command).replace(/\s+/g, " ").length > 120 ? "…" : ""} · exit ${validation.exitCode}${validation.duration ? ` · ${validation.duration}` : ""}`)),
    message.validationMissing
      ? h(Text, { color: theme.warning }, "Check  not run")
      : null,
  );
}

function PermissionDisplay({ message }) {
  const theme = useTheme();
  return h(Box, { flexDirection: "column", marginBottom: 1, paddingLeft: 1 },
    h(Text, { bold: true, color: theme.warning }, "Action required"),
    h(Text, { color: theme.assistant, wrap: "wrap" }, message.reason),
    message.tool ? h(Text, { color: theme.toolTarget, wrap: "wrap" }, `${message.tool}  ${message.target || ""}`.trim()) : null,
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
      case "permission":
        return h(PermissionDisplay, { key: m.id, message: m });
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
