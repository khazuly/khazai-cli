import { createElement as h } from "react";
import { Box, Text } from "ink";
import { useTheme } from "../theme.js";
import { Panel } from "./surface.js";

function wrapPath(value, width) {
  const lines = [];
  let current = "";
  for (const token of String(value || "").split(/(?<=[/\\_-])/)) {
    if (current && current.length + token.length > width) {
      lines.push(current);
      current = "";
    }
    let remaining = token;
    while (remaining.length > width) {
      lines.push(remaining.slice(0, width));
      remaining = remaining.slice(width);
    }
    current += remaining;
  }
  if (current) lines.push(current);
  return lines;
}

export function PermissionPrompt({ request = {}, options = [], selectedIndex = 0, width }) {
  const theme = useTheme();
  const target = request.target || {};
  const targetLines = target.label === "Path"
    ? wrapPath(target.value, Math.max(8, width - 8))
    : [target.value];
  return h(Panel, {
    tone: "warning",
    width,
    marginLeft: 1,
    marginBottom: 1,
  },
    h(Text, { bold: true, color: theme.warning }, "Action required"),
    h(Box, { marginTop: 1 },
      h(Text, { color: theme.assistant, wrap: "wrap" },
        request.action || "KhazAI needs permission to continue.",
      ),
    ),
    target.value
      ? h(Box, { flexDirection: "column", marginTop: 1 },
          h(Text, { bold: true, color: theme.metadata }, `${target.label || "Target"}:`),
          h(Box, { flexDirection: "column", marginLeft: 2, flexShrink: 1 },
            ...targetLines.map((line, index) => h(Text, {
              key: `${index}-${line}`,
              color: theme.toolTarget,
              wrap: "wrap",
            }, line)),
          ),
        )
      : null,
    h(Box, { flexDirection: "column", marginTop: 1 },
      ...options.map((option, index) => h(Text, {
        key: option,
        color: index === selectedIndex ? theme.secondary : theme.assistant,
        bold: index === selectedIndex,
        wrap: "wrap",
      }, index === selectedIndex ? "› " : "  ", option)),
    ),
    h(Text, { color: theme.metadata, dimColor: true, wrap: "wrap" },
      "↑↓ Select · Enter Confirm · Esc Reject",
    ),
  );
}
