import { createElement as h } from "react";
import { Box, Text, useStdout } from "ink";
import { useTheme } from "../theme.js";

const EXAMPLES = [
  "explain this repository",
  "fix failing tests",
  "create REST API",
  "optimize this code",
];

export function EmptyState() {
  const theme = useTheme();
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns || 80;

  return h(Box, {
    flexDirection: "column",
    alignItems: "center",
    width: "100%",
    marginBottom: 1,
    marginTop: 1,
  },
    h(Box, {
      flexDirection: "column",
      alignItems: "center",
      borderStyle: "single",
      borderColor: theme.border,
      paddingX: 3,
      paddingY: 1,
      width: Math.max(12, Math.min(60, terminalWidth - 4)),
    },
      h(Text, { bold: true, color: theme.primary }, "Welcome to KhazAI"),
      h(Text, { dimColor: true, color: theme.metadata }, "Your AI-powered CLI coding assistant"),
      h(Box, { flexDirection: "column", marginTop: 1, width: "100%" },
        h(Text, { dimColor: true, color: theme.metadata }, "Try asking:"),
        ...EXAMPLES.map(example =>
          h(Text, { key: example, color: theme.secondary, wrap: "wrap" }, `  → ${example}`)),
      ),
    ),
  );
}
