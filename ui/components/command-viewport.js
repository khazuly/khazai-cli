import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStdin, useStdout } from "ink";
import { canonicalCommand } from "../commands.js";

export const COMMAND_VIEWPORT_SIZE = 6;

function clampIndex(index, itemCount) {
  if (itemCount === 0) return -1;
  return Math.max(0, Math.min(itemCount - 1, index));
}




export function findSubCommands(commands, input) {
  const slashIndex = input.indexOf("/");
  if (slashIndex < 0) return null;
  const commandName = input.slice(slashIndex).split(" ")[0];

  const canonical = canonicalCommand(commandName);
  const cmd = canonical || commands.find(item => item.name === commandName);
  return cmd?.sub ? { cmd, items: cmd.sub } : null;
}

export function filterCommandItems(items, input, prefixLength) {
  const partial = input.slice(prefixLength).toLowerCase();
  if (!partial) return items;
  return items.filter(item =>
    item.name.toLowerCase().includes(partial)
    || item.description?.toLowerCase().includes(partial)
  );
}





export function filterCanonicalCommands(commands, input) {
  if (!input.startsWith("/")) return [];
  const partial = input.slice(input.indexOf("/") + 1).toLowerCase();
  if (!partial) return commands.filter(c => c.visible !== false);

  return commands.filter(c => {
    if (c.visible === false) return false;
    const canonicalName = c.name.slice(1).toLowerCase();
    if (canonicalName.startsWith(partial)) return true;

    if (c.aliases?.some(a => a.slice(1).toLowerCase().startsWith(partial) || a.toLowerCase().startsWith("/" + partial))) return true;
    return false;
  });
}

export function useCommandBoundaryKeys(enabled, lastIndex, selectIndex) {
  const { stdin } = useStdin();
  const navigationRef = useRef({ enabled, lastIndex, selectIndex });
  navigationRef.current = { enabled, lastIndex, selectIndex };

  useEffect(() => {
    const handleData = data => {
      const raw = String(data);
      if (!navigationRef.current.enabled) return;
      if (/^\u001b(?:\[H|OH|\[1~|\[7~)$/.test(raw)) navigationRef.current.selectIndex(0);
      if (/^\u001b(?:\[F|OF|\[4~|\[8~)$/.test(raw)) {
        navigationRef.current.selectIndex(navigationRef.current.lastIndex);
      }
    };
    stdin?.on("data", handleData);
    return () => stdin?.off("data", handleData);
  }, [stdin]);
}

export function useCommandViewport(items, resetKey) {
  const { stdout } = useStdout();
  const [columns, setColumns] = useState(stdout?.columns || 80);
  useEffect(() => {
    const handleResize = () => setColumns(stdout?.columns || 80);
    stdout?.on?.("resize", handleResize);
    return () => stdout?.off?.("resize", handleResize);
  }, [stdout]);
  const resetKeyWithWidth = `${resetKey}\u0001w:${columns}`;
  const [selectedIndex, setSelectedIndex] = useState(() => items.length ? 0 : -1);
  const [scrollOffset, setScrollOffset] = useState(0);
  const selectedIndexRef = useRef(selectedIndex);
  const scrollOffsetRef = useRef(scrollOffset);
  const itemCount = items.length;
  selectedIndexRef.current = selectedIndex;
  scrollOffsetRef.current = scrollOffset;

  useLayoutEffect(() => {
    const initialIndex = itemCount ? 0 : -1;
    if (selectedIndexRef.current !== initialIndex) {
      selectedIndexRef.current = initialIndex;
      setSelectedIndex(initialIndex);
    }
    if (scrollOffsetRef.current !== 0) {
      scrollOffsetRef.current = 0;
      setScrollOffset(0);
    }
  }, [resetKeyWithWidth, itemCount]);

  const selectIndex = requestedIndex => {
    const nextIndex = clampIndex(requestedIndex, itemCount);
    selectedIndexRef.current = nextIndex;
    setSelectedIndex(nextIndex);
    setScrollOffset(currentOffset => {
      let nextOffset = currentOffset;
      if (nextIndex < 0) nextOffset = 0;
      else if (nextIndex < currentOffset) nextOffset = nextIndex;
      if (nextIndex >= currentOffset + COMMAND_VIEWPORT_SIZE) {
        nextOffset = nextIndex - COMMAND_VIEWPORT_SIZE + 1;
      }
      const maximumOffset = Math.max(0, itemCount - COMMAND_VIEWPORT_SIZE);
      nextOffset = Math.min(nextOffset, maximumOffset);
      scrollOffsetRef.current = nextOffset;
      return nextOffset;
    });
  };

  const safeSelectedIndex = clampIndex(selectedIndex, itemCount);
  const safeScrollOffset = Math.min(
    scrollOffset,
    Math.max(0, itemCount - COMMAND_VIEWPORT_SIZE),
  );

  return {
    selectedIndex: safeSelectedIndex,
    scrollOffset: safeScrollOffset,
    selectedItem: items[safeSelectedIndex],
    visibleItems: items.slice(safeScrollOffset, safeScrollOffset + COMMAND_VIEWPORT_SIZE),
    selectIndex,
    resetSelection: () => selectIndex(0),
  };
}
