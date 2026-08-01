import { createElement as h } from "react";
import { Box, Text, useStdout } from "ink";
import { COMMAND_CATEGORIES } from "../commands.js";
import { COMMAND_VIEWPORT_SIZE } from "./command-viewport.js";

function commandRow(item, viewport, localIndex, inSubMode, activeModel, theme, layout) {
  const selected = viewport.scrollOffset + localIndex === viewport.selectedIndex;
  const name = item.name || "";
  const description = item.description || "";
  const active = inSubMode && item.name === activeModel;
  return h(Box, { key: name, flexShrink: 0, width: "100%" },
    h(Box, { width: layout.markerColumn, flexShrink: 0 },
      h(Text, { color: selected ? theme.secondary : undefined, bold: selected }, selected ? "›" : " "),
    ),
    h(Box, { flexShrink: 0, marginRight: 2 },
      h(Text, { color: selected ? theme.secondary : undefined, bold: selected || active }, name),
    ),
    description
      ? h(Box, { flexGrow: 1, minWidth: 0, width: layout.descriptionWidth },
        h(Text, { dimColor: true, wrap: "truncate-end" }, description),
      )
      : null,
    active ? h(Box, { flexShrink: 0 }, h(Text, { dimColor: true }, "(active)")) : null,
  );
}

export function CommandDropdown({ commandResults, commandViewport, inSubMode, subInfo, activeModel, theme }) {
  const label = inSubMode ? subInfo.cmd.name.slice(1) : "Commands";
  const total = commandResults.length;
  const rangeStart = total > COMMAND_VIEWPORT_SIZE ? commandViewport.scrollOffset + 1 : null;
  const rangeEnd = rangeStart
    ? Math.min(commandViewport.scrollOffset + COMMAND_VIEWPORT_SIZE, total)
    : null;
  const { stdout } = useStdout();
  const terminalWidth = Math.max(24, stdout?.columns || 80);
  const dropdownWidth = Math.max(24, Math.min(72, terminalWidth - 2));
  const commandColumn = Math.max(
    3,
    Math.min(24, ...commandResults.map(item => String(item.name || "").length)),
  );
  const layout = {
    markerColumn: 2,
    descriptionWidth: Math.max(8, dropdownWidth - commandColumn - 5),
  };
  const rows = [];
  let currentCategory = null;
  commandViewport.visibleItems.forEach((item, index) => {
    if (!inSubMode && item.category && item.category !== currentCategory) {
      currentCategory = item.category;
      if (index > 0 || commandViewport.scrollOffset === 0) {
        const category = COMMAND_CATEGORIES.find(entry => entry.id === currentCategory)?.label || currentCategory;
        rows.push(h(Box, { key: `cat-${currentCategory}`, flexShrink: 0 },
          h(Text, { color: theme.metadata, dimColor: true }, category),
        ));
      }
    }
    rows.push(commandRow(item, commandViewport, index, inSubMode, activeModel, theme, layout));
  });
  return h(Box, {
    flexDirection: "column",
    marginLeft: 2,
    marginBottom: 1,
    width: dropdownWidth,
  },
    h(Text, { color: theme.metadata },
      label,
      rangeStart ? ` · ${rangeStart}–${rangeEnd} of ${total}` : "",
    ),
    ...rows,
  );
}
