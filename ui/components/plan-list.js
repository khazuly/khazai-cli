import { createElement as h } from "react";
import { Text, Box } from "ink";
import { useTheme } from "../theme.js";

export function planItemPresentation(status) {
  if (status === "done") return { indicator: "[✓]", colorRole: "success" };
  if (status === "running") return { indicator: "[•]", colorRole: "secondary" };
  if (status === "failed") return { indicator: "[!]", colorRole: "error" };
  return { indicator: "[] ", colorRole: "muted" };
}

export function PlanList({ plan }) {
  const theme = useTheme();
  if (!plan || plan.length === 0) return null;
  const finished = plan.filter(item => ["done", "failed", "skipped"].includes(item.status)).length;

  return h(Box, { flexDirection: "column", marginBottom: 1 },
    h(Box, {},
      h(Text, { bold: true, color: theme.primary }, "Plan"),
      h(Text, { color: theme.metadata }, `  ${finished}/${plan.length}`),
    ),
    h(Box, { flexDirection: "column", marginTop: 1 },
      ...plan.map((item, index) => {
        const status = item.status === "running" && plan.findIndex(entry => entry.status === "running") !== index
          ? "pending"
          : item.status;
        const { indicator, colorRole } = planItemPresentation(status);
        return h(Box, { key: `${index}-${item.description}`, width: "100%" },
          h(Text, { color: theme[colorRole], wrap: "truncate-end" }, `${indicator} `),
          h(Text, { color: theme.text, flexGrow: 1, wrap: "wrap" }, item.description)
        );
      })
    )
  );
}
