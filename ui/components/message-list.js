import { createElement as h } from "react";
import { Text, Box } from "ink";
import { ToolCall } from "./tool-call.js";
import { Thinking } from "./thinking.js";

function truncateResult(text, maxLines = 4) {
  if (!text) return null;
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join("\n") + `\n  ... (${lines.length - maxLines} more)`;
}

export function MessageList({ messages }) {
  const items = messages.map(m => {
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
          h(ToolCall, { tool: m.tool, args: m.args, done: m.done }),
          m.done && m.content
            ? h(Box, { marginLeft: 3 },
                h(Text, { dimColor: true }, truncateResult(m.content))
              )
            : null
        );
      case "answer":
        return h(Box, { key: m.id, marginLeft: 2 },
          h(Text, {}, m.content)
        );
      case "error":
        return h(Box, { key: m.id, marginLeft: 2 },
          h(Text, { color: "red" }, "✗ ", m.content)
        );
      default:
        return null;
    }
  }).filter(Boolean);

  return h(Box, { flexDirection: "column" }, ...items);
}
