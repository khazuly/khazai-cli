import { createElement as h, memo } from "react";
import { Text, Box, useStdout } from "ink";
import stringWidth from "string-width";
import { normalizePlanState } from "../../app/agent/plan.js";
import { useTheme } from "../theme.js";

export function planItemPresentation(status) {
  if (["done", "completed"].includes(status)) return { indicator: "[✓]", colorRole: "success" };
  if (["running", "active", "in_progress"].includes(status)) return { indicator: "[•]", colorRole: "secondary" };
  if (["failed", "blocked", "cancelled"].includes(status)) return { indicator: "[×]", colorRole: "error" };
  return { indicator: "[ ]", colorRole: "muted" };
}

export function completedPlanCount(plan) {
  return (Array.isArray(plan) ? plan : []).filter(item => ["done", "completed"].includes(item.status)).length;
}

export function planItemKey(planId, item) {
  return `${planId}:${item.id}`;
}

export function visiblePlanTitle(title, columns = 80) {
  const text = String(title || "");
  const budget = Math.max(12, (Math.max(20, columns) - 6) * 3);
  if (stringWidth(text) <= budget) return text;
  let visible = "";
  for (const word of text.split(/\s+/)) {
    const candidate = visible ? `${visible} ${word}` : word;
    if (stringWidth(candidate) > budget) break;
    visible = candidate;
  }
  return visible ? `${visible}…` : `${text.slice(0, Math.max(1, budget - 1)).trim()}…`;
}

function PlanListInner({ plan, planId: planIdProp }) {
  const theme = useTheme();
  const { stdout } = useStdout();
  const state = Array.isArray(plan)
    ? normalizePlanState({ planId: planIdProp || plan.find(item => item.planId)?.planId || "plan", steps: plan })
    : plan || { planId: null, currentStepId: null, steps: [] };
  const items = state.steps;
  const planId = planIdProp || state.planId;
  if (items.length === 0) return null;
  const finished = completedPlanCount(items);
  const columns = stdout?.columns || 80;

  return h(Box, { flexDirection: "column", marginBottom: 1 },
    h(Text, { bold: true, color: theme.primary }, `Todos ${finished}/${items.length}`),
    h(Box, { flexDirection: "column", marginTop: 1 },
      ...items.map(item => {
        const status = item.status === "active" && item.id !== state.currentStepId ? "pending" : item.status;
        const { indicator, colorRole } = planItemPresentation(status);
        const title = item.description || item.text || item.content || item.title || "";
        return h(Box, {
          key: planItemKey(planId, item),
          flexDirection: "row",
          width: "100%",
        },
          h(Box, { width: 4, flexShrink: 0 },
            h(Text, { color: theme[colorRole], wrap: "truncate-end" }, indicator),
          ),
          h(Box, { flexGrow: 1, minWidth: 0 },
            h(Text, { color: theme.text, wrap: "wrap" }, visiblePlanTitle(title, columns)),
          ),
        );
      }),
    ),
  );
}

export const PlanList = memo(PlanListInner);
