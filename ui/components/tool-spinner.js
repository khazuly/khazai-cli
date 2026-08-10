import { createElement as h, memo } from "react";
import { Box, Text } from "ink";
import stringWidth from "string-width";
import { useTheme } from "../theme.js";

export const TOOL_ACTIVE_MARKER = "•";

export const ToolSpinner = memo(function ToolSpinner({
  active = false,
  color,
  label,
  children = null,
}) {
  const theme = useTheme();
  const marker = active ? TOOL_ACTIVE_MARKER : " ";

  return h(Box, { flexDirection: "row", width: "100%" },
    h(Box, { width: 4, flexShrink: 0 },
      h(Text, { color: color || theme.muted }, marker),
    ),
    h(Box, { flexDirection: "column", flexGrow: 1, flexShrink: 1, minWidth: 0 },
      h(Box, { flexDirection: "row", width: "100%" },
        h(Box, { flexShrink: 1, minWidth: 0 },
          h(Text, { bold: true, color: color || theme.muted, wrap: "truncate-end" }, label),
        ),
      ),
      children,
    ),
  );
});
