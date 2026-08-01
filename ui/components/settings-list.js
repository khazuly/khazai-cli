import { createElement as h, useCallback, useRef, useState } from "react";
import { Box, Text } from "ink";
import { useTheme } from "../theme.js";

export const VIEWPORT_SIZE = 6;














export function SettingRow({ marker, label, value, valueColor, selected, dimValue }) {
  const theme = useTheme();
  return h(Box, { width: "100%" },

    marker !== undefined
      ? h(Box, { width: 2, flexShrink: 0 },
          h(Text, { color: selected ? theme.primary : theme.text }, marker),
        )
      : null,

    h(Box, { flexGrow: 1, minWidth: 0 },
      h(Text, {
        color: selected ? theme.primary : theme.text,
        bold: selected,
      }, label),
    ),

    value !== undefined && value !== null
      ? h(Box, { marginLeft: 2, flexShrink: 0 },
          h(Text, {
            color: valueColor || theme.secondary,
            dimColor: dimValue,
          }, String(value)),
        )
      : null,
  );
}



function clampIndex(index, count) {
  if (count === 0) return -1;
  return Math.max(0, Math.min(count - 1, index));
}



export function useScrollable(items) {
  const [selectedIndex, setSelectedIndex] = useState(items.length ? 0 : -1);
  const [scrollOffset, setScrollOffset] = useState(0);
  const selectedRef = useRef(selectedIndex);
  const scrollRef = useRef(scrollOffset);
  const itemCount = items.length;

  const select = useCallback(requested => {
    const next = clampIndex(requested, itemCount);
    selectedRef.current = next;
    setSelectedIndex(next);
    setScrollOffset(prev => {
      let off = prev;
      if (next < 0) off = 0;
      else if (next < off) off = next;
      if (next >= off + VIEWPORT_SIZE) off = next - VIEWPORT_SIZE + 1;
      return Math.min(off, Math.max(0, itemCount - VIEWPORT_SIZE));
    });
  }, [itemCount]);

  return {
    selectedIndex,
    scrollOffset,
    selectedItem: items[selectedIndex] || null,
    visibleItems: items.slice(scrollOffset, scrollOffset + VIEWPORT_SIZE),
    select,
  };
}



