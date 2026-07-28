import { createElement as h } from "react";
import { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { presentTool } from "../tool-presentation.js";
import { useTheme } from "../theme.js";
import { StatusRail } from "./surface.js";

function stateColor(state, theme) {
  if (state === "failed") return theme.error;
  if (state === "warning") return theme.warning;
  if (state === "running") return theme.info;
  return theme.success;
}

function inspectorLines(presentation) {
  const output = String(presentation.preview.lines.join("\n") || "").split("\n").filter(Boolean);
  const sections = [
    presentation.details.length ? { label: "Details", lines: presentation.details } : null,
    output.length ? { label: "Output", lines: output } : null,
  ].filter(Boolean);
  return sections.flatMap((section, index) => [
    ...(index ? [{ type: "space", text: "" }] : []),
    { type: "heading", text: section.label },
    ...section.lines.map(text => ({ type: "content", text })),
  ]);
}

function clamp(value, maximum) {
  return Math.max(0, Math.min(value, Math.max(0, maximum)));
}

export function ToolDetailInspector({ message, onClose }) {
  const { stdout } = useStdout();
  const theme = useTheme();
  const [offset, setOffset] = useState(0);
  const presentation = useMemo(() => presentTool({
    tool: message.tool,
    title: message.title,
    args: message.args,
    done: message.done,
    failed: message.failed,
    duration: message.duration,
    resultSize: message.resultSize,
    content: message.content,
    metadata: message.metadata,
    expanded: true,
  }), [message]);
  const lines = useMemo(() => inspectorLines(presentation), [presentation]);
  const pageSize = Math.max(6, Math.min(24, Number(stdout?.rows || 24) - 8));
  const maximumOffset = Math.max(0, lines.length - pageSize);

  useEffect(() => setOffset(0), [message.id]);

  useInput((input, key) => {
    if (key.escape || input === "q") {
      onClose();
      return;
    }
    if (key.upArrow) setOffset(value => clamp(value - 1, maximumOffset));
    if (key.downArrow) setOffset(value => clamp(value + 1, maximumOffset));
    if (key.pageUp) setOffset(value => clamp(value - pageSize, maximumOffset));
    if (key.pageDown) setOffset(value => clamp(value + pageSize, maximumOffset));
    if (key.home) setOffset(0);
    if (key.end) setOffset(maximumOffset);
  });

  const visible = lines.slice(offset, offset + pageSize);
  const marker = theme.colorEnabled ? presentation.marker : presentation.monoMarker;
  const color = theme.colorEnabled ? stateColor(presentation.state, theme) : undefined;
  const range = lines.length
    ? `${offset + 1}–${Math.min(lines.length, offset + pageSize)} of ${lines.length}`
    : "empty";

  return h(StatusRail, {
    width: "100%",
    marginBottom: 1,
    tone: presentation.stateRole,
  },
    h(Box, { width: "100%" },
      h(Text, { bold: true, color }, `${marker} ${presentation.label}`),
      presentation.target
        ? h(Text, { color: theme.toolTarget, wrap: "truncate-end" }, `  ${presentation.target}`)
        : null,
    ),
    h(Text, { color: theme.metadata },
      [presentation.statusLabel, ...presentation.metadata, presentation.duration].filter(Boolean).join(" · "),
    ),
    h(Box, { flexDirection: "column", marginTop: visible.length ? 1 : 0 },
      ...visible.map((line, index) => h(Text, {
        key: `${offset}-${index}`,
        bold: line.type === "heading",
        color: line.type === "heading" ? theme.text : theme.toolResult,
        wrap: "wrap",
      }, line.text || " ")),
    ),
    h(Text, { color: theme.metadata },
      `${range} · ↑↓ scroll · PgUp/PgDn page · Esc close`,
    ),
  );
}
