import { createElement as h, memo } from "react";
import { Text, Box } from "ink";
import { useTheme } from "../theme.js";

const OUTCOME_SYMBOLS = {
  completed: "[✓]",
  completed_with_warnings: "[!]",
  partial: "[!]",
  failed: "[×]",
  cancelled: "[−]",
};

const OUTCOME_LABELS = {
  completed: "Completed",
  completed_with_warnings: "Completed with warnings",
  partial: "Partially completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) || 0));
  const seconds = Math.floor(total / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${String(secs).padStart(2, "0")}s`;
}

export const OutcomeRow = memo(function OutcomeRow({ outcome, expanded = false }) {
  const theme = useTheme();
  if (!outcome) return null;

  const { status, warnings = [], failures = [], duration } = outcome;
  const symbol = OUTCOME_SYMBOLS[status] || "[?]";
  const label = OUTCOME_LABELS[status] || status;
  const formatted = formatDuration(duration);

  const color =
    status === "completed"
      ? theme.success
      : status === "cancelled"
        ? theme.muted
        : status === "failed"
          ? theme.error
          : theme.warning;

  const items = [...failures, ...warnings];

  return h(Box, { flexDirection: "column", width: "100%", marginBottom: 1 },
    h(Text, { color },
      symbol, " ", label, " · ", formatted,
    ),
    expanded && items.length > 0
      ? h(Box, { flexDirection: "column", marginLeft: 2, marginTop: 1 },
          ...items.map((item, i) =>
            h(Text, { key: i, color: theme.muted, wrap: "wrap" },
              "· ", item,
            ),
          ),
        )
      : null,
  );
});
