import { createElement as h } from "react";
import { Text, Box, useStdout } from "ink";
import { useTheme } from "../theme.js";

export const MODEL_LABELS = {
  "big-cock": "Big Cock",
};

export function Banner({ model, workspace, agent = "build", autoApprove = false }) {
  const { stdout } = useStdout();
  const theme = useTheme();
  const modelLabel = MODEL_LABELS[model] || model;
  const home = process.env.HOME || "";
  const displayWorkspace = home && workspace.startsWith(home + "/")
    ? "~/" + workspace.slice(home.length + 1)
    : workspace;
  const terminalWidth = stdout?.columns || 80;
  const approval = autoApprove ? "auto" : "review";
  const right = `${displayWorkspace} · ${agent} · ${approval}`;
  const title = `KhazAI · ${modelLabel}`;
  const gap = Math.max(1, terminalWidth - title.length - right.length - 2);
  const compact = terminalWidth < 60;

  return h(Box, {
    flexDirection: compact ? "column" : "row",
    width: terminalWidth,
    paddingLeft: 1,
    paddingRight: 1,
    borderStyle: "single",
    borderTop: false,
    borderLeft: false,
    borderRight: false,
    borderColor: theme.border,
  },
    h(Text, { bold: true },
      h(Text, { color: theme.primary }, "KhazAI"),
      h(Text, { color: theme.muted }, " · "),
      h(Text, { color: theme.secondary }, modelLabel),
    ),
    compact
      ? h(Text, { color: theme.metadata, wrap: "truncate-end" }, right)
      : h(Text, { color: theme.metadata, wrap: "truncate-end" }, " ".repeat(gap), right),
  );
}
