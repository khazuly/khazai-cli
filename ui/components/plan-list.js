import { createElement as h, memo, useRef, useState } from "react";
import { Text, Box, useStdout } from "ink";
import stringWidth from "string-width";
import { useTheme } from "../theme.js";

export function planItemPresentation(status) {
  if (["done", "completed"].includes(status)) return { indicator: "[✓]", colorRole: "success" };
  if (["running", "active"].includes(status)) return { indicator: "[•]", colorRole: "secondary" };
  if (["failed", "blocked"].includes(status)) return { indicator: "[×]", colorRole: "error" };
  return { indicator: "[ ]", colorRole: "muted" };
}

export function completedPlanCount(plan) {
  return (Array.isArray(plan) ? plan : []).filter(item => ["done", "completed"].includes(item.status)).length;
}

export function planItemKey(planId, item, index) {
  return `${planId || "plan"}:${item?.stepId || item?.id || index}`;
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

function PlanListInner({ plan, planId: planIdProp, collapsed: collapsedProp }) {
  const theme = useTheme();
  const { stdout } = useStdout();
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const lastPlanIdRef = useRef(null);
  const items = Array.isArray(plan) ? plan : [];
  const planId = planIdProp || items.find(item => item.planId)?.planId || "plan";
  const collapsed = collapsedProp === undefined ? internalCollapsed : collapsedProp;
  if (collapsedProp === undefined && lastPlanIdRef.current !== null && lastPlanIdRef.current !== planId) {
    lastPlanIdRef.current = planId;
    if (internalCollapsed) setInternalCollapsed(false);
  }
  lastPlanIdRef.current = planId;
  if (items.length === 0) return null;
  const finished = completedPlanCount(items);
  const columns = stdout?.columns || 80;

  return h(Box, { flexDirection: "column", marginBottom: 1 },
    h(Box, { flexDirection: "row", flexWrap: "wrap", alignItems: "center" },
      h(Text, { bold: true, color: theme.primary }, `Plan ${finished}/${items.length}`),
      h(Box, { marginLeft: 2 },
        h(Text, { color: theme.metadata }, collapsed ? "[+ Show]" : "[− Hide]"),
      ),
    ),
    collapsed
      ? null
      : h(Box, { flexDirection: "column", marginTop: 1 },
          ...items.map((item, index) => {
            const { indicator, colorRole } = planItemPresentation(item.status);
            const title = item.description || item.text || item.content || item.title || "";
            return h(Box, {
              key: planItemKey(planId, item, index),
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
