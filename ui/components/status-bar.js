import { createElement as h, useEffect, useState } from "react";
import { Text, Box } from "ink";
import { useStdout } from "ink";
import stringWidth from "string-width";
import { useTheme } from "../theme.js";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function compactTokens(value) {
  const tokens = Math.max(0, Number(value) || 0);
  if (tokens < 1_000) return String(Math.round(tokens));
  return `${(tokens / 1_000).toFixed(tokens < 100_000 ? 1 : 0)}k`;
}

export function StatusBar({
  running,
  waitingForAnswer = false,
  queueCount = 0,
  model = "",
  modeStatus = null,
  contextUsage = {},
}) {
  const { stdout } = useStdout();
  const theme = useTheme();
  const [frame, setFrame] = useState(0);
  const [now, setNow] = useState(Date.now());
  const {
    currentContextTokens = 0,
    contextLimit = null,
    contextLimitKnown = contextLimit !== null && contextLimit > 0,
    compactionStatus = "idle",
    compactionStartedAt = null,
  } = contextUsage;
  const compacting = ["scheduled", "preparing", "summarizing", "committing", "recounting"]
    .includes(compactionStatus);
  useEffect(() => {
    if (!compacting) return undefined;
    const timer = setInterval(() => {
      setFrame(value => value + 1);
      setNow(Date.now());
    }, 120);
    return () => clearInterval(timer);
  }, [compacting]);
  const name = model || "KhazAI";
  const queue = queueCount > 0 ? ` · ${queueCount} queued` : "";
  const elapsed = compactionStartedAt
    ? ` · ${Math.max(0, Math.floor((now - compactionStartedAt) / 1_000))}s`
    : "";
  const compactionText = ["scheduled", "preparing"].includes(compactionStatus)
    ? `Preparing compaction${elapsed}`
    : compactionStatus === "summarizing"
      ? `${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} Compacting context${elapsed}`
      : compactionStatus === "committing"
        ? `Committing compacted context${elapsed}`
        : `Recalculating context${elapsed}`;
  const modeText = modeStatus?.mode === "plan"
    ? `Plan Mode · ${modeStatus.status === "questioning"
      ? "Waiting for decision"
      : modeStatus.status === "reviewing"
        ? "Reviewing implementation"
        : "Investigating"}`
    : modeStatus?.mode === "build"
      ? `Build Mode · ${modeStatus.status === "verifying"
        ? "Running verification"
        : modeStatus.status === "implementing"
          ? "Implementing approved plan"
          : "Preparing approved plan"}`
      : "";
  const leftText = compacting
    ? `${name} · ${compactionText}`
    : modeText
      ? `${name} · ${modeText}${queue}${running ? " · Esc cancel" : ""}`
    : waitingForAnswer
      ? `${name} · Waiting for answer${queue} · Esc cancel`
      : running
        ? `${name} · Working${queue} · Esc cancel`
        : `${name}${queue} · Enter send`;

  // Context display: known limit shows "6.2k / 128k · 5%", unknown shows "6.2k · Limit unknown"
  const tokenDisplay = compactTokens(currentContextTokens);
  const limitDisplay = contextLimit ? compactTokens(contextLimit) : null;
  const usagePercent = contextLimitKnown && contextLimit > 0
    ? Math.min(100, Math.max(0, Math.floor((currentContextTokens / contextLimit) * 100)))
    : null;
  const contextText = contextLimitKnown
    ? `Context ${tokenDisplay} / ${limitDisplay} · ${usagePercent}%`
    : `Context ${tokenDisplay} · Limit unknown`;

  const contextColor = contextLimitKnown && usagePercent >= 100
    ? theme.error
    : contextLimitKnown && usagePercent >= 80
      ? theme.warning
      : theme.muted;
  const terminalWidth = Math.max(20, stdout?.columns || 80);
  const stacked = stringWidth(leftText) + stringWidth(contextText) + 2 > terminalWidth;

  return h(Box, {
    width: "100%",
    flexDirection: stacked ? "column" : "row",
  },
    h(Box, { flexGrow: 1, flexShrink: 1, minWidth: 0 },
      h(Text, { color: compacting ? theme.primary : theme.metadata, wrap: "wrap" }, leftText),
    ),
    h(Box, {
      flexShrink: 0,
      marginLeft: stacked ? 0 : 2,
      justifyContent: stacked ? "flex-end" : "flex-start",
      width: stacked ? "100%" : undefined,
    },
      h(Text, { color: contextColor }, contextText),
    ),
  );
}
