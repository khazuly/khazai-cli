import { createElement as h } from "react";
import { Box, Text } from "ink";

const EXAMPLES = [
  "explain this repository",
  "fix failing tests",
  "create REST API",
  "optimize this code",
];

export function EmptyState() {
  return h(Box, { flexDirection: "column", marginBottom: 1 },
    h(Text, { bold: true }, "Ready."),
    h(Box, { flexDirection: "column", marginTop: 1 },
      h(Text, { dimColor: true }, "Examples"),
      h(Box, { flexDirection: "column", marginTop: 1, marginLeft: 2 },
        ...EXAMPLES.map(example => h(Text, { key: example, dimColor: true, wrap: "wrap" }, example))
      )
    )
  );
}
