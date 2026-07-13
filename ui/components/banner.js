import { createElement as h } from "react";
import { Text, Box, useStdout } from "ink";
import { PASTEL } from "../palette.js";

export const MODEL_LABELS = {
  gpt: "GPT-4o-mini",
  claude: "Claude Haiku",
  qwen: "Qwen 2.5",
};

export function Banner({ model, workspace }) {
  const { stdout } = useStdout();
  const modelLabel = MODEL_LABELS[model] || model;
  const home = process.env.HOME || "";
  const displayWorkspace = home && workspace.startsWith(home + "/")
    ? "~/" + workspace.slice(home.length + 1)
    : workspace;
  const terminalWidth = stdout?.columns || 80;
  const title = `khazai-ai   ${modelLabel}`;
  const underlineWidth = Math.min(
    Math.max(1, terminalWidth - 4),
    Math.max(Array.from(title).length, Array.from(displayWorkspace).length) + 4,
  );

  return h(Box, {
    flexDirection: "column",
    alignItems: "center",
    // Static items do not inherit a useful percentage width in every Ink
    // renderer. Bind the banner to the real terminal width so centering is
    // relative to the viewport instead of the banner's longest child.
    width: terminalWidth,
    marginBottom: 1,
  },
    h(Text, { bold: true },
      h(Text, { color: PASTEL.mauve }, "khazai-ai"),
      h(Text, { color: PASTEL.slate }, "   "),
      h(Text, { color: PASTEL.lavender }, modelLabel),
    ),
    h(Text, { dimColor: true, wrap: "truncate-end" }, displayWorkspace),
    h(Text, { color: PASTEL.slate }, "━".repeat(underlineWidth)),
  );
}
