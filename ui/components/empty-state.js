import { createElement as h } from "react";
import { Box, Text } from "ink";
import { useTheme } from "../theme.js";

const EXAMPLES = [
  "explain this repository",
  "fix failing tests",
  "create REST API",
  "optimize this code",
];

export function EmptyState() {
  const theme = useTheme();
  return h(Box, { flexDirection: "column", marginBottom: 1 },
    h(Text, { bold: true, color: theme.primary }, "Ready"),
    h(Box, { flexDirection: "column", marginTop: 1 },
      h(Text, { color: theme.metadata }, "Try"),
      h(Box, { flexDirection: "column", marginTop: 1, marginLeft: 2 },
        ...EXAMPLES.map(example => h(Text, { key: example, color: theme.muted, wrap: "wrap" }, example))
      )
    )
  );
}
