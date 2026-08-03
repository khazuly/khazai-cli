export const INITIAL_HISTORY_LIMIT = 80;

export function recentHistoryWindow(messages, limit = INITIAL_HISTORY_LIMIT) {
  const source = Array.isArray(messages) ? messages : [];
  const count = Math.max(1, Number(limit) || INITIAL_HISTORY_LIMIT);
  if (source.length <= count) return source;
  const hiddenCount = source.length - count;
  return [
    {
      id: `history-window-${hiddenCount}`,
      type: "history-window",
      hiddenCount,
    },
    ...source.slice(-count),
  ];
}

export function appendVisibleHistory(messages, message) {
  return [...messages, message];
}
