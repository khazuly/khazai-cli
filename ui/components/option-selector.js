import { createElement as h } from "react";
import { Box, Text } from "ink";
import { COMMAND_VIEWPORT_SIZE } from "./command-viewport.js";
import { PermissionPrompt } from "./permission-prompt.js";

export function OptionSelector({
  context,
  kind,
  options,
  permissionRequest,
  question,
  selectedIndex,
  theme,
  width,
}) {
  if (kind === "permission") {
    return h(PermissionPrompt, {
      request: permissionRequest,
      options,
      selectedIndex,
      width,
    });
  }
  const maximumOffset = Math.max(0, options.length - COMMAND_VIEWPORT_SIZE);
  const offset = Math.min(maximumOffset, Math.max(0, selectedIndex - COMMAND_VIEWPORT_SIZE + 1));
  const visibleOptions = options.slice(offset, offset + COMMAND_VIEWPORT_SIZE);
  const managerStyle = kind === "mcp";
  const normalized = option => typeof option === "string"
    ? { id: option, label: option, description: "", recommended: false }
    : option;
  const selected = normalized(options[selectedIndex] || "");
  return h(Box, { flexDirection: "column", width, marginLeft: 2 },
    question ? h(Text, { color: theme.metadata, bold: true, wrap: "truncate-end" }, question) : null,
    context ? h(Text, { color: theme.muted, wrap: "wrap" }, context) : null,
    ...visibleOptions.map((option, visibleIndex) => {
      const index = offset + visibleIndex;
      const item = normalized(option);
      const label = `${item.label}${item.recommended ? " (Recommended)" : ""}`;
      return h(Text, {
        key: item.id || `${index}-${item.label}`,
        color: index === selectedIndex ? theme.secondary : undefined,
        bold: index === selectedIndex,
        wrap: "truncate-end",
        width,
      },
      index === selectedIndex ? (managerStyle ? "› " : "> ") : "  ",
      managerStyle || kind === "plan" ? label : `${index + 1}. ${label}`);
    }),
    selected.description
      ? h(Box, { marginTop: 1 },
          h(Text, { color: theme.metadata, wrap: "wrap" }, selected.description),
        )
      : null,
    options.length > COMMAND_VIEWPORT_SIZE
      ? h(Text, { color: theme.metadata, dimColor: true },
          `${offset + 1}–${Math.min(offset + COMMAND_VIEWPORT_SIZE, options.length)} of ${options.length}`,
        )
      : null,
    h(Text, { dimColor: true, wrap: "truncate-end", width },
      "↑↓ Select · PgUp/PgDn · Enter Confirm · Esc Cancel",
    ),
  );
}
