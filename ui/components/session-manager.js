import { createElement as h } from "react";
import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "../theme.js";

const VISIBLE_COUNT = 6;

function clamp(index, count) {
  if (!count) return -1;
  return Math.max(0, Math.min(count - 1, index));
}

export function relativeSessionTime(value, now = Date.now()) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Unknown";
  const elapsed = Math.max(0, now - timestamp);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  if (hours < 48) return "Yesterday";
  return `${Math.floor(hours / 24)}d ago`;
}

export function sessionManagerItems(sessions) {
  return [
    ...(Array.isArray(sessions) ? sessions : []).map(session => ({
      ...session,
      kind: "session",
      label: session.title || "Untitled session",
    })),
    { id: "clear-all", kind: "clear", label: "Clear all sessions" },
  ];
}

export function formatSessionList(sessions, currentSessionId, workspacePath, now = Date.now()) {
  if (!sessions.length) return "No saved sessions found for this folder.";
  return [
    `Sessions · ${workspacePath}`,
    "",
    ...sessions.map(session => {
      const current = session.id === currentSessionId ? " · Current" : "";
      const count = session.messageCount ? ` · ${session.messageCount} messages` : "";
      return `${session.title || "Untitled session"}${current}${count} · Updated ${relativeSessionTime(session.updatedAt, now)} · ${session.id}`;
    }),
    "",
    `${sessions.length} saved session${sessions.length === 1 ? "" : "s"}`,
  ].join("\n");
}

function SessionRow({ item, selected, current, now }) {
  const theme = useTheme();
  const detail = item.kind === "session"
    ? [
        current ? "Current" : null,
        item.messageCount ? `${item.messageCount} messages` : null,
      ].filter(Boolean).join(" · ")
    : "";
  return h(Box, { width: "100%", flexShrink: 0 },
    h(Box, { width: 2, flexShrink: 0 },
      h(Text, { color: selected ? theme.primary : theme.text, bold: selected }, selected ? "›" : " "),
    ),
    h(Box, { flexGrow: 1, minWidth: 0, flexDirection: "column" },
      h(Text, { color: selected ? theme.primary : theme.text, bold: selected, wrap: "truncate-end" }, item.label),
      detail ? h(Text, { color: theme.metadata, dimColor: true, wrap: "truncate-end" }, detail) : null,
    ),
    item.kind === "session"
      ? h(Box, { marginLeft: 2, flexShrink: 0 },
          h(Text, { color: theme.metadata, dimColor: true }, `Updated ${relativeSessionTime(item.updatedAt, now)}`),
        )
      : null,
  );
}

function RemovalConfirmation({ item, onCancel, onConfirm }) {
  const theme = useTheme();
  const [selected, setSelected] = useState(0);
  const choices = ["Cancel", item.kind === "clear" ? "Clear all sessions" : "Remove"];
  useInput((input, key) => {
    if (key.upArrow || key.downArrow) setSelected(value => value === 0 ? 1 : 0);
    else if (input === "1" || input === "2") {
      const index = Number(input) - 1;
      setSelected(index);
      if (index === 0) onCancel();
      else onConfirm(item);
    } else if (key.return) {
      if (selected === 0) onCancel();
      else onConfirm(item);
    } else if (key.escape) {
      onCancel();
    }
  });
  return h(Box, { flexDirection: "column", width: "100%" },
    h(Text, { bold: true, color: theme.primary },
      item.kind === "clear"
        ? "Clear all sessions for this folder?"
        : `Remove session \`${item.label}\`?`,
    ),
    h(Box, { flexDirection: "column", marginTop: 1 },
      ...choices.map((choice, index) => h(Text, {
        key: choice,
        color: index === selected ? theme.primary : theme.text,
        bold: index === selected,
      }, index === selected ? "› " : "  ", choice)),
    ),
    h(Text, { color: theme.metadata, dimColor: true, marginTop: 1 },
      "↑↓ Select · Enter Confirm · Esc Cancel"),
  );
}

export function SessionManager({
  workspacePath,
  sessions,
  currentSessionId,
  onResume,
  onDelete,
  onClear,
  onClose,
}) {
  const theme = useTheme();
  const items = useMemo(() => sessionManagerItems(sessions), [sessions]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [confirmation, setConfirmation] = useState(null);
  const nowRef = useRef(Date.now());

  const move = delta => {
    setSelectedIndex(current => clamp(current + delta, items.length));
  };

  const scrollOffset = Math.min(
    Math.max(0, selectedIndex - VISIBLE_COUNT + 1),
    Math.max(0, items.length - VISIBLE_COUNT),
  );

  useEffect(() => {
    setSelectedIndex(current => clamp(current, items.length));
  }, [items.length]);

  useInput((input, key) => {
    if (confirmation) return;
    if (key.upArrow) move(-1);
    else if (key.downArrow) move(1);
    else if (key.pageUp) move(-VISIBLE_COUNT);
    else if (key.pageDown) move(VISIBLE_COUNT);
    else if (key.home) setSelectedIndex(0);
    else if (key.end) setSelectedIndex(items.length - 1);
    else if (key.return) {
      const item = items[selectedIndex];
      if (!item) return;
      if (item.kind === "clear") setConfirmation(item);
      else onResume(item.id);
    } else if (key.delete) {
      const item = items[selectedIndex];
      if (item?.kind === "session") setConfirmation(item);
    } else if (key.escape) {
      onClose();
    }
  });

  if (confirmation) {
    return h(RemovalConfirmation, {
      item: confirmation,
      onCancel: () => setConfirmation(null),
      onConfirm: item => {
        setConfirmation(null);
        if (item.kind === "clear") onClear();
        else onDelete(item.id);
      },
    });
  }

  return h(Box, { flexDirection: "column", width: "100%" },
    h(Text, { bold: true, color: theme.primary }, `Sessions · ${workspacePath}`),
    sessions.length === 0
      ? h(Text, { color: theme.metadata, marginTop: 1 }, "No saved sessions found for this folder.")
      : h(Box, { flexDirection: "column", marginTop: 1 },
          ...items.slice(scrollOffset, scrollOffset + VISIBLE_COUNT).map((item, index) => h(SessionRow, {
            key: item.id,
            item,
            selected: scrollOffset + index === selectedIndex,
            current: item.id === currentSessionId,
            now: nowRef.current,
          })),
        ),
    items.length > VISIBLE_COUNT
      ? h(Text, { color: theme.metadata, dimColor: true },
          `${scrollOffset + 1}–${Math.min(scrollOffset + VISIBLE_COUNT, items.length)} of ${items.length}`)
      : null,
    h(Text, { color: theme.metadata, dimColor: true, marginTop: 1 },
      `${sessions.length} saved session${sessions.length === 1 ? "" : "s"}`),
    h(Text, { color: theme.metadata, dimColor: true },
      "↑↓ Select · Enter Resume · Del Delete · Esc Close"),
  );
}
