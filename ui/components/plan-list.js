import { createElement as h } from "react";
import { Text, Box } from "ink";
import { PASTEL } from "../palette.js";

export function planItemPresentation(status) {
  if (status === "done") return { indicator: "[✓]", color: PASTEL.green };
  if (status === "running") return { indicator: "[•]", color: PASTEL.lavender };
  if (status === "failed") return { indicator: "", color: PASTEL.rose };
  return { indicator: "", color: PASTEL.muted };
}

export function PlanList({ plan }) {
  if (!plan || plan.length === 0) return null;
  const finished = plan.filter(item => ["done", "failed", "skipped"].includes(item.status)).length;

  return h(Box, { flexDirection: "column", marginBottom: 1 },
    h(Box, {},
      h(Text, { bold: true }, "Plan"),
      h(Text, { dimColor: true }, `  ${finished}/${plan.length}`),
    ),
    h(Box, { flexDirection: "column", marginTop: 1 },
      ...plan.map((item, index) => {
        // The renderer is the final presentation boundary: keep only the
        // first running item active even if an out-of-order update arrives.
        const status = item.status === "running" && plan.findIndex(entry => entry.status === "running") !== index
          ? "pending"
          : item.status;
        const { indicator, color } = planItemPresentation(status);
        return h(Box, { key: `${index}-${item.description}`, width: "100%" },
          h(Text, { color, wrap: "truncate-end" }, `${indicator ? `${indicator} ` : "    "}`),
          h(Text, { color, flexGrow: 1, wrap: "wrap" }, item.description)
        );
      })
    )
  );
}
