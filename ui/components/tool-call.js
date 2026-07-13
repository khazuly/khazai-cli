import { createElement as h } from "react";
import { Box, Text } from "ink";
import { presentTool, TOOL_STATE_COLORS } from "../tool-presentation.js";
import { PASTEL } from "../palette.js";

function resultColor(state) {
  if (state === "failed") return TOOL_STATE_COLORS.failed;
  if (state === "warning") return TOOL_STATE_COLORS.warning;
  return undefined;
}

function ResultPreview({ presentation }) {
  const rows = [];
  if (presentation.searchResults) {
    for (const item of presentation.searchResults.items) {
      rows.push(h(Box, { key: `result-${item.index}`, width: "100%", alignItems: "flex-start" },
        h(Text, { color: presentation.accent, dimColor: true }, `${item.index}. `),
        h(Box, { flexDirection: "column", flexGrow: 1 },
          h(Text, { wrap: "wrap" }, item.title),
          item.description
            ? h(Text, { dimColor: true, wrap: "wrap" }, item.description)
            : null,
        )
      ));
    }
    if (presentation.searchResults.hidden) {
      rows.push(h(Text, { key: "hidden-results", dimColor: true }, `show ${presentation.searchResults.hidden} more...`));
    }
  } else {
    for (const [index, line] of presentation.preview.lines.entries()) {
      rows.push(h(Text, {
        key: `line-${index}`,
        color: resultColor(presentation.state),
        wrap: "wrap",
      }, line));
    }
    if (presentation.preview.hiddenLines) {
      rows.push(h(Text, { key: "hidden-lines", dimColor: true }, `show ${presentation.preview.hiddenLines} more lines...`));
    }
    if (presentation.preview.hiddenChars) {
      rows.push(h(Text, { key: "hidden-chars", dimColor: true }, `show ${presentation.preview.hiddenChars} more chars...`));
    }
  }
  return rows.length ? h(Box, { flexDirection: "column" }, ...rows) : null;
}

export function ToolCall({ tool, args, done, duration, resultSize, content, expanded = false }) {
  const presentation = presentTool({ tool, args, done, duration, resultSize, content, expanded });
  const stateLabel = presentation.state === "running"
    ? "running..."
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
    paddingRight: 1,
    marginBottom: 1,
  },
    h(Box, { flexShrink: 0, width: "100%" },
      h(Text, { bold: true, color: presentation.accent }, presentation.label),
      h(Box, { flexGrow: 1 }),
      presentation.duration
        ? h(Text, { color: TOOL_STATE_COLORS[presentation.state] }, presentation.duration)
        : null,
      stateLabel && presentation.state !== "running"
        ? h(Text, { color: resultColor(presentation.state) }, presentation.duration ? `  ${stateLabel}` : stateLabel)
        : null,
    ),
    presentation.target
      ? h(Text, { color: PASTEL.text, wrap: "wrap" }, presentation.target)
      : null,
    presentation.metadata.length
      ? h(Text, { dimColor: true, wrap: "wrap" }, presentation.metadata.join(" · "))
      : null,
    presentation.state === "running"
      ? h(Text, { color: TOOL_STATE_COLORS.running, dimColor: true }, stateLabel)
      : null,
    done ? h(ResultPreview, { presentation }) : null,
  );
}
