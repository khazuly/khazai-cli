import { createElement as h } from "react";
import { Text, Box } from "ink";
import { useTheme } from "../theme.js";
import { PrefixRow } from "./surface.js";

export function planItemPresentation(status) {
  if (["done", "completed"].includes(status)) return { indicator: "[✓]", colorRole: "success" };
  if (["running", "active"].includes(status)) return { indicator: "[•]", colorRole: "secondary" };
  if (["failed", "blocked"].includes(status)) return { indicator: "[×]", colorRole: "error" };
  return { indicator: "[ ]", colorRole: "muted" };
}

export function completedPlanCount(plan) {
  return (Array.isArray(plan) ? plan : []).filter(item => ["done", "completed"].includes(item.status)).length;
}

export function PlanList({ plan }) {
  const theme = useTheme();
  if (!plan || plan.length === 0) return null;
  const finished = completedPlanCount(plan);

  return h(Box, { flexDirection: "column", marginBottom: 1 },
    h(Box, {},
      h(Text, { bold: true, color: theme.primary }, "Plan"),
      h(Text, { color: theme.metadata }, ` ${finished}/${plan.length}`),
    ),
    h(Box, { flexDirection: "column", marginTop: 1 },
      ...plan.map((item, index) => {
        const status = item.status === "running" && plan.findIndex(entry => entry.status === "running") !== index
          ? "pending"
          : item.status;
        const { indicator, colorRole } = planItemPresentation(status);
        return h(PrefixRow, { key: `${index}-${item.description}`, prefix: indicator, prefixColor: theme[colorRole] },
          h(Text, { color: theme.text, wrap: "wrap" }, item.description),
        );
      })
    )
  );
}
