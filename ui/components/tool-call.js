import { createElement as h } from "react";
import { Box, Text, useStdout } from "ink";
import { memo, useEffect, useState } from "react";
import stringWidth from "string-width";
import { formatDuration, presentTool } from "../tool-presentation.js";
import { useTheme } from "../theme.js";
import { PrefixRow, StatusRail } from "./surface.js";
import { ToolSpinner } from "./tool-spinner.js";

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

function DetailRows({ rows, state, theme, width, live = false }) {
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
          wrap: live ? "truncate-end" : "wrap",
        }, row.value),
      ),
    )),
  );
}

function ReadBatchElapsed({ startedAt, finishedAt, color }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (finishedAt) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 100);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [finishedAt]);
  return h(Text, { bold: true, color, wrap: "truncate-end" },
    ` · ${formatDuration(Math.max(0, (finishedAt || now) - startedAt))}`,
  );
}

function ReadBatchDetails({ batch, theme }) {
  return h(Box, { flexDirection: "column", marginTop: 1 },
    h(Text, { bold: true, color: theme.toolRead }, `Read ${batch.total} ${batch.total === 1 ? "file" : "files"}`),
    ...batch.entries.map(entry => {
      const duration = entry.finishedAt ? formatDuration(entry.finishedAt - entry.startedAt) : "running";
      const prefix = entry.finishedAt ? entry.failed ? "[!]" : "[✓]" : "[•]";
      const color = entry.failed ? theme.error : entry.finishedAt ? theme.success : theme.primary;
      return h(PrefixRow, {
        key: entry.callId,
        prefix,
        prefixColor: color,
      }, h(Text, { color, wrap: "wrap" }, `${entry.displayPath} · ${duration}`));
    }),
  );
}

export const ReadGroupCall = memo(function ReadGroupCall({ batch, expanded = false }) {
  const theme = useTheme();
  const hasFailures = batch.failed > 0;
  const done = Boolean(batch.done);
  const countLabel = hasFailures
    ? `Read ${batch.completed}/${batch.total} ${batch.total === 1 ? "file" : "files"}`
    : `Read ${batch.total} ${batch.total === 1 ? "file" : "files"}`;
  const prefix = hasFailures ? "[!]" : done ? "[✓]" : "[•]";
  const color = hasFailures ? theme.error : done ? theme.success : theme.primary;
  return h(StatusRail, { flexShrink: 0, width: "100%", tone: hasFailures ? "error" : done ? "success" : "muted" },
    h(PrefixRow, { prefix, prefixColor: color },
      h(Box, { flexDirection: "row", width: "100%" },
        h(Text, { bold: true, color, wrap: "truncate-end" }, countLabel),
        h(ReadBatchElapsed, { startedAt: batch.startedAt, finishedAt: batch.finishedAt, color }),
      ),
      done && !expanded
        ? h(Text, { color: hasFailures ? theme.error : theme.metadata, dimColor: !hasFailures },
            `${hasFailures ? `${batch.failed} failed · ` : ""}/expand`)
        : null,
      done && expanded ? h(ReadBatchDetails, { batch, theme }) : null,
    ),
  );
});

export const ToolCall = memo(function ToolCall({ tool, args, done, duration, startedAt, resultSize, content, metadata, expanded = false, readGroup = false, readBatch, status, toolCallId = "", scopeKey = "" }) {
  if (readGroup) return h(ReadGroupCall, { batch: readBatch, expanded });
  const { stdout } = useStdout();
  const theme = useTheme();
  if (tool === "unknown_tool") {
    const requestedTool = String(args?.requestedTool || "").trim();
    return h(StatusRail, { flexShrink: 0, width: "100%", tone: "error" },
      h(PrefixRow, { prefix: "[×]", prefixColor: theme.error },
        h(Text, { bold: true, color: theme.error, wrap: "wrap" },
          ["Unknown tool", requestedTool].filter(Boolean).join(" · "),
        ),
      ),
    );
  }
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
  const running = presentation.state === "running"
    && !["pending", "awaiting-approval"].includes(status);
  const prefix = presentation.state === "failed" || presentation.state === "warning"
    ? "[×]"
    : ["pending", "awaiting-approval"].includes(status) ? "[ ]"
      : "[✓]";
  const shell = tool === "bash";
  const shellWaiting = ["pending", "awaiting-approval"].includes(status);
  const elapsed = shell
    ? shellWaiting || running ? "" : shellDuration(duration, done)
    : "";
  const shellState = shellWaiting ? stateLabel : "";
  const heading = [
    presentation.label,
    shellState || stateLabel,
    shell ? elapsed : presentation.duration,
  ].filter(Boolean).join(" · ");
  const width = Math.max(13, Number(stdout?.columns || 80) - 7);
  const rows = toolDetails(tool, presentation, done);

  if (running) {
    return h(StatusRail, { flexShrink: 0, width: "100%", tone },
      h(ToolSpinner, {
        active: true,
        color: accent,
        label: `${presentation.label} · ${stateLabel}`,
      }, h(DetailRows, {
        rows,
        state: presentation.state,
        theme,
        width,
        live: true,
      })),
    );
  }

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
});
