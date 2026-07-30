import { createElement as h } from "react";
import { Box, Text, useStdout } from "ink";
import { useEffect, useState } from "react";
import stringWidth from "string-width";
import { formatDuration, presentTool } from "../tool-presentation.js";
import { useTheme } from "../theme.js";
import { PrefixRow, StatusRail } from "./surface.js";
import { SPINNER_FRAMES } from "./status-bar.js";

const DETAIL_LABELS = ["Command", "URL", "Path", "Query", "Pattern", "Type", "Size", "Result", "Error", "Exit", "More"];
const DETAIL_LABEL_WIDTH = Math.max(...DETAIL_LABELS.map(label => stringWidth(label))) + 1;

function resultColor(state, theme) {
  if (state === "failed") return theme.error;
  if (state === "warning") return theme.warning;
  return theme.toolResult;
}

function shellDuration(ms, done) {
  if (!Number.isFinite(ms)) return "";
  if (!done) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (ms < 1000) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function targetDetails(tool, presentation) {
  if (tool === "bash" && presentation.expanded && presentation.fullCommand) {
    return [{ label: "Command", value: presentation.fullCommand }];
  }
  return presentation.targets || [];
}

function metadataDetails(tool, presentation) {
  if (tool === "web" || tool === "webfetch") {
    return [
      presentation.metadata[0] ? { label: "Type", value: presentation.metadata[0] } : null,
      presentation.metadata.length > 1 ? { label: "Size", value: presentation.metadata.slice(1).join(" · ") } : null,
    ].filter(Boolean);
  }
  if (tool === "bash") {
    const exit = presentation.metadata.find(item => /^exit\s+-?\d+$/i.test(item));
    return exit && exit !== "exit 0" ? [{ label: "Exit", value: exit.slice(5) }] : [];
  }
  return [];
}

function resultDetails(presentation) {
  if (presentation.searchResults) {
    return presentation.searchResults.items.map(item => ({
      label: "Result",
      value: [item.title, item.description].filter(Boolean).join(" — "),
    }));
  }
  const preview = presentation.expanded ? presentation.preview : presentation.resultPreview;
  const label = presentation.state === "failed" ? "Error" : "Result";
  return (preview?.lines || []).map(value => ({
    label,
    value: String(value).replace(/^(?:Error|Result|Title):\s*/i, ""),
  }));
}

function toolDetails(tool, presentation, done) {
  const rows = [
    ...targetDetails(tool, presentation),
    ...metadataDetails(tool, presentation),
    ...(done ? resultDetails(presentation) : []),
  ];
  if (done && !presentation.expanded && presentation.expandable) {
    rows.push({ label: "More", value: "/expand", muted: true });
  }
  return rows;
}

function DetailRows({ rows, state, theme, width }) {
  if (!rows.length) return null;
  const labelWidth = Math.min(DETAIL_LABEL_WIDTH, Math.max(5, width - 8));
  const valueWidth = Math.max(8, width - labelWidth);
  return h(Box, { flexDirection: "column", width },
    ...rows.map((row, index) => h(Box, {
      key: `${row.label}-${index}`,
      flexDirection: "row",
      alignItems: "flex-start",
      width,
    },
      h(Box, { width: labelWidth, flexShrink: 0 },
        h(Text, { color: theme.metadata, dimColor: true, wrap: "truncate-end" }, row.label),
      ),
      h(Box, { width: valueWidth, flexShrink: 1 },
        h(Text, {
          color: row.muted ? theme.metadata : resultColor(state, theme),
          dimColor: Boolean(row.muted),
          wrap: "wrap",
        }, row.value),
      ),
    )),
  );
}

function ReadGroupCall({ count, currentFile, done, duration, failed, status, failedCount }) {
  const { stdout } = useStdout();
  const [frame, setFrame] = useState(0);
  const theme = useTheme();
  useEffect(() => {
    if (done || ["pending", "awaiting-approval"].includes(status)) return undefined;
    const timer = setInterval(() => setFrame(value => value + 1), 80);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [done, status]);
  const label = `Read ${count} ${count === 1 ? "file" : "files"}`;
  const elapsed = duration ? ` · ${formatDuration(duration)}` : "";
  let icon;
  let heading;
  if (failed) {
    icon = "[×]";
    const failurePart = failedCount ? ` · ${failedCount} failed` : "";
    heading = `${label}${failurePart} · ${currentFile || ""}${elapsed}`;
  } else if (done) {
    icon = "[✓]";
    heading = `${label}${elapsed}`;
  } else {
    icon = ["pending", "awaiting-approval"].includes(status) ? "[ ]" : SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
    heading = `${label} · ${currentFile || ""}`;
  }
  const width = Math.max(13, Number(stdout?.columns || 80) - 7);
  return h(StatusRail, { flexShrink: 0, width: "100%", tone: failed ? "error" : done ? "success" : "muted" },
    h(PrefixRow, { prefix: icon, prefixColor: failed ? theme.error : done ? theme.success : theme.primary },
      h(Text, { bold: true, color: failed ? theme.error : done ? theme.success : theme.primary, wrap: "wrap" }, heading),
    ),
  );
}

export function ToolCall({ tool, args, done, duration, startedAt, resultSize, content, metadata, expanded = false, readGroup = false, count, currentFile, failed, status, totalLines, failurePreview, failedCount }) {
  if (readGroup) return h(ReadGroupCall, { count, currentFile, done, duration, failed, status, failedCount });
  const { stdout } = useStdout();
  const theme = useTheme();
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (done || ["pending", "awaiting-approval"].includes(status)) return undefined;
    const timer = setInterval(() => setFrame(value => value + 1), 80);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [done, status]);
  const presentation = presentTool({ tool, args, done, duration, resultSize, content, metadata, expanded });
  const accent = theme.colorEnabled ? theme[presentation.accentRole] : undefined;
  const stateLabel = status === "awaiting-approval"
    ? "awaiting approval"
    : status === "pending"
      ? "pending"
    : presentation.state === "running"
    ? "running"
    : presentation.statusLabel;

  const tone = presentation.state === "failed" || presentation.state === "warning"
    ? presentation.stateRole
    : "muted";
  const prefix = presentation.state === "failed" || presentation.state === "warning"
    ? "[×]"
    : ["pending", "awaiting-approval"].includes(status) ? "[ ]"
      : presentation.state === "running" ? SPINNER_FRAMES[frame % SPINNER_FRAMES.length] : "[✓]";
  const shell = tool === "bash";
  const shellWaiting = ["pending", "awaiting-approval"].includes(status);
  const elapsed = shell
    ? shellWaiting ? "" : shellDuration(done ? duration : startedAt ? Date.now() - startedAt : 0, done)
    : "";
  const shellState = shellWaiting ? stateLabel : "";
  const heading = [
    presentation.label,
    shellState || stateLabel,
    shell ? elapsed : presentation.duration,
  ].filter(Boolean).join(" · ");
  const width = Math.max(13, Number(stdout?.columns || 80) - 7);
  const rows = toolDetails(tool, presentation, done);

  return h(StatusRail, {
    flexShrink: 0,
    width: "100%",
    tone,
  },
    h(PrefixRow, { prefix, prefixColor: accent },
      h(Text, { bold: true, color: accent, wrap: "wrap" },
        heading,
      ),
      h(DetailRows, { rows, state: presentation.state, theme, width }),
    ),
  );
}
