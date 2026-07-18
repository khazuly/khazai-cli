import { createElement as h } from "react";
import { Text, Box } from "ink";
import { PASTEL } from "../palette.js";
import { useTheme } from "../theme.js";

export function planItemPresentation(status, palette = PASTEL) {
  if (status === "done") return { indicator: "[✓]", color: palette.success ?? palette.green };
  if (status === "running") return { indicator: "[•]", color: palette.secondary ?? palette.lavender };
  if (status === "failed") return { indicator: "", color: palette.error ?? palette.rose };
  return { indicator: "", color: palette.muted };
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
        // The renderer is the final presentation boundary: keep only the
        // first running item active even if an out-of-order update arrives.
        const status = item.status === "running" && plan.findIndex(entry => entry.status === "running") !== index
          ? "pending"
          : item.status;
        const { indicator, color } = planItemPresentation(status, theme);
        return h(Box, { key: `${index}-${item.description}`, width: "100%" },
          h(Text, { color, wrap: "truncate-end" }, `${indicator ? `${indicator} ` : "    "}`),
          h(Text, { color, flexGrow: 1, wrap: "wrap" }, item.description)
        );
      })
    )
  );
}
