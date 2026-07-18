import { createElement as h } from "react";
import { Box, Text } from "ink";
import { presentTool } from "../tool-presentation.js";
import { useTheme } from "../theme.js";

function resultColor(state, theme) {
  if (state === "failed") return theme.error;
  if (state === "warning") return theme.warning;
  return theme.toolResult;
}

function ResultPreview({ presentation, theme }) {
  const rows = [];
  if (presentation.searchResults) {
    for (const item of presentation.searchResults.items) {
      rows.push(h(Box, { key: `result-${item.index}`, width: "100%", alignItems: "flex-start" },
        h(Text, { color: presentation.accent, dimColor: true }, `${item.index}. `),
        h(Box, { flexDirection: "column", flexGrow: 1 },
          h(Text, { color: theme.toolResult, wrap: "wrap" }, item.title),
          item.description
            ? h(Text, { color: theme.metadata, wrap: "wrap" }, item.description)
            : null,
        )
      ));
    }
    if (presentation.searchResults.hidden) {
      rows.push(h(Text, { key: "hidden-results", color: theme.metadata }, `show ${presentation.searchResults.hidden} more...`));
    }
  } else {
    for (const [index, line] of presentation.preview.lines.entries()) {
      rows.push(h(Text, {
        key: `line-${index}`,
        color: resultColor(presentation.state, theme),
        wrap: "wrap",
      }, line));
    }
    if (presentation.preview.hiddenLines) {
      rows.push(h(Text, { key: "hidden-lines", color: theme.metadata }, `show ${presentation.preview.hiddenLines} more lines...`));
    }
    if (presentation.preview.hiddenChars) {
      rows.push(h(Text, { key: "hidden-chars", color: theme.metadata }, `show ${presentation.preview.hiddenChars} more chars...`));
    }
  }
  return rows.length ? h(Box, { flexDirection: "column" }, ...rows) : null;
}

export function ToolCall({ tool, args, done, duration, resultSize, content, expanded = false }) {
  const theme = useTheme();
  const presentation = presentTool({ tool, args, done, duration, resultSize, content, expanded });
  const accent = theme.colorEnabled ? presentation.accent : undefined;
  const stateColor = presentation.state === "failed"
    ? theme.error
    : presentation.state === "warning"
      ? theme.warning
      : presentation.state === "running"
        ? theme.secondary
        : theme.muted;
  const stateLabel = presentation.state === "running"
    ? null
    : presentation.state === "failed"
      ? "failed"
      : presentation.state === "warning"
        ? "warning"
        : null;

  return h(Box, {
    flexDirection: "column",
    flexShrink: 0,
    width: "100%",
    paddingLeft: 1,
    marginBottom: 1,
  },
    h(Box, { flexShrink: 0, width: "100%" },
      h(Box, { flexShrink: 0 },
        h(Text, { bold: true, color: accent }, presentation.label),
      ),
      presentation.target
        ? h(Box, { flexShrink: 1, minWidth: 1 },
            h(Text, { color: theme.toolTarget, wrap: "truncate-end" }, "  ", presentation.target)
          )
        : null,
      h(Box, { flexGrow: 1, minWidth: 1 }),
      presentation.duration
        ? h(Box, { flexShrink: 0 }, h(Text, { color: stateColor }, presentation.duration))
        : null,
      stateLabel && presentation.state !== "running"
        ? h(Text, { color: resultColor(presentation.state, theme) }, presentation.duration ? `  ${stateLabel}` : stateLabel)
        : null,
    ),
    presentation.metadata.length
      ? h(Text, { color: theme.metadata, wrap: "wrap" }, presentation.metadata.join(" · "))
      : null,
    presentation.state === "running"
      ? h(Text, { color: stateColor, dimColor: true }, stateLabel)
      : null,
    done && (expanded || presentation.state === "failed" || presentation.state === "warning")
      ? h(ResultPreview, { presentation, theme })
      : null,
  );
}
