import { createElement as h } from "react";
import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { presentTool } from "../tool-presentation.js";
import { useTheme } from "../theme.js";
import { StatusRail } from "./surface.js";
import { SPINNER_FRAMES } from "./status-bar.js";

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
        h(Text, { color: theme[presentation.accentRole], dimColor: true }, `${item.index}. `),
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

function ReadGroupCall({ count, currentFile, done, duration, failed }) {
  const [frame, setFrame] = useState(0);
  const theme = useTheme();
  useEffect(() => {
    if (done) return undefined;
    const timer = setInterval(() => setFrame(value => value + 1), 80);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [done]);
  const files = `${count} ${count === 1 ? "file" : "files"}`;
  const icon = failed ? "[×]" : done ? "[✓]" : SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
  const details = failed
    ? `Read ${files} · failed${currentFile ? ` · ${currentFile}` : ""}`
    : done
      ? `Read ${files} · ${duration < 1000 ? `${duration} ms` : `${(duration / 1000).toFixed(1)} s`}`
      : `Read ${files}${currentFile ? ` · ${currentFile}` : ""}`;
  return h(StatusRail, { flexShrink: 0, width: "100%", tone: failed ? "error" : done ? "success" : "muted" },
    h(Text, { bold: true, color: failed ? theme.error : done ? theme.success : theme.primary, wrap: "wrap" }, `${icon} ${details}`),
  );
}

export function ToolCall({ tool, args, done, duration, resultSize, content, expanded = false, readGroup = false, count, currentFile, failed }) {
  if (readGroup) return h(ReadGroupCall, { count, currentFile, done, duration, failed });
  const theme = useTheme();
  const presentation = presentTool({ tool, args, done, duration, resultSize, content, expanded });
  const accent = theme.colorEnabled ? theme[presentation.accentRole] : undefined;
  const stateLabel = presentation.state === "running"
    ? "running"
    : presentation.statusLabel;

  const tone = presentation.state === "failed" || presentation.state === "warning"
    ? presentation.stateRole
    : "muted";

  return h(StatusRail, {
    flexShrink: 0,
    width: "100%",
    tone,
  },
    h(Text, { bold: true, color: accent, wrap: "wrap" },
      presentation.label,
      stateLabel ? ` · ${stateLabel}` : "",
      presentation.duration ? ` · ${presentation.duration}` : "",
    ),
    presentation.summary
      ? h(Text, { color: theme.toolTarget, wrap: "wrap" }, presentation.summary)
      : null,
    presentation.metadata.length
      ? h(Text, { color: theme.metadata, wrap: "wrap" }, `${presentation.metadata.join(" · ")}${done && !expanded ? " · /expand" : ""}`)
      : null,
    expanded && presentation.details.length
      ? h(Box, { flexDirection: "column", marginTop: 1 },
          ...presentation.details.map((detail, index) => h(Text, {
            key: `detail-${index}`,
            color: theme.metadata,
            wrap: "wrap",
          }, detail)),
        )
      : null,
    done && (expanded || presentation.state === "failed" || presentation.state === "warning")
      ? h(ResultPreview, { presentation, theme })
      : null,
  );
}
