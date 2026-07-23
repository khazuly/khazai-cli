import { createElement as h } from "react";
import { Box } from "ink";
import { useTheme } from "../theme.js";

export function Panel({ children, tone = "border", ...props }) {
  const theme = useTheme();
  return h(Box, {
    flexDirection: "column",
    borderStyle: "round",
    borderColor: theme[tone],
    paddingX: 1,
    ...props,
  }, children);
}

export function StatusRail({ children, tone = "muted", ...props }) {
  const theme = useTheme();
  return h(Box, {
    flexDirection: "column",
    borderStyle: "single",
    borderTop: false,
    borderBottom: false,
    borderRight: false,
    borderColor: theme[tone],
    paddingLeft: 1,
    ...props,
  }, children);
}
