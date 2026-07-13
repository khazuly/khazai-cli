import { createElement as h } from "react";
import { Text, Box } from "ink";
import { PASTEL } from "../palette.js";

function itemStyle(status) {
  if (status === "failed") return { color: PASTEL.rose, prefix: "failed" };
  if (status === "running") return { color: PASTEL.lavender, prefix: "now" };
  if (status === "done") return { dimColor: true, prefix: "done" };
  if (status === "skipped") return { dimColor: true, prefix: "skip" };
  return { dimColor: true, prefix: "next" };
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
        const { prefix, ...style } = itemStyle(item.status);
        return h(Box, { key: `${index}-${item.description}` },
          h(Text, { ...style }, `${prefix.padEnd(6)} ${item.description}`)
        );
      })
    )
  );
}
