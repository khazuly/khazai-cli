import { createElement as h } from "react";
import { Text, Box, useStdout } from "ink";
import stringWidth from "string-width";
import { useTheme } from "../theme.js";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function compactTokens(value) {
  const tokens = Math.max(0, Number(value) || 0);
  if (tokens < 1_000) return String(Math.round(tokens));
  return `${(tokens / 1_000).toFixed(tokens < 100_000 ? 1 : 0)}k`;
}









export function StatusBar({
  running = false,
  model = "",
  contextUsage = {},
}) {
  const { stdout } = useStdout();
  const theme = useTheme();
  const {
    currentContextTokens = 0,
    contextLimit = null,
    contextLimitKnown = contextLimit !== null && contextLimit > 0,
  } = contextUsage;

  const name = model || "KhazAI";
  const modelStatus = running ? name : `${name} · Enter send`;


  const tokenDisplay = compactTokens(currentContextTokens);
  const limitDisplay = contextLimit ? compactTokens(contextLimit) : null;
  const usagePercent = contextLimitKnown && contextLimit > 0
    ? Math.min(100, Math.max(0, Math.round(
      Number.isFinite(contextUsage.usagePercent)
        ? contextUsage.usagePercent
        : (currentContextTokens / contextLimit) * 100,
    )))
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
  const stacked = stringWidth(modelStatus) + stringWidth(contextText) + 2 > terminalWidth;

  return h(Box, {
    width: "100%",
    flexDirection: stacked ? "column" : "row",
  },
    h(Box, { flexGrow: 1, flexShrink: 1, minWidth: 0 },
      h(Text, { color: theme.metadata, wrap: stacked ? "wrap" : "truncate-end" }, modelStatus),
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
