import { createElement as h } from "react";
import { Text, Box, useStdout } from "ink";
import { useTheme } from "../theme.js";
import { zenModels } from "../../config/khazai-free-models.js";

export const MODEL_LABELS = {
  ...Object.fromEntries(zenModels().flatMap(model => [
    [model.alias, model.displayName],
    [model.key, model.displayName],
  ])),
  "auto-free": "Auto (free)",
};

export function Banner({ model, workspace, agent = "build", autoApprove = false }) {
  const { stdout } = useStdout();
  const theme = useTheme();
  const modelLabel = MODEL_LABELS[model] || model;
  const home = process.env.HOME || "";
  const displayWorkspace = home && workspace.startsWith(home + "/")
    ? "~/" + workspace.slice(home.length + 1)
    : workspace;
  const approval = autoApprove ? "auto" : "review";
  const right = `${displayWorkspace} · ${agent} · ${approval}`;
  const compact = (stdout?.columns || 80) < 60;

  return h(Box, {
    flexDirection: "row",
    width: "100%",
    borderStyle: "single",
    borderTop: false,
    borderLeft: false,
    borderRight: false,
    borderColor: theme.border,
  },
    h(Box, { paddingLeft: 1 },
      h(Text, { bold: true, color: theme.primary }, "KhazAI"),
      h(Text, { dimColor: true, color: theme.metadata }, ` · ${modelLabel}`),
    ),
    h(Box, { flexGrow: 1 }),
    h(Box, { paddingRight: 1 },
      h(Text, { dimColor: true, color: theme.metadata, wrap: "truncate-end" },
        compact ? right.replace(/ · [^·]*$/, "") : right),
    ),
  );
}
