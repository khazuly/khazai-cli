import { createElement as h } from "react";
import { Text, Box } from "ink";
import { useState, useEffect } from "react";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const DISPLAY_FIXES = [
  [/\bpython3?\s+-m\s+ht\b(?!\.server)/g, "python3 -m http.server"],
  [/\bpython3?\s+-m\s+http\s+server/g, "python3 -m http.server"],
];

function fixDisplay(cmd) {
  let s = cmd;
  for (const [re, to] of DISPLAY_FIXES) s = s.replace(re, to);
  return s;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatSize(bytes) {
  if (!bytes) return null;
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatLines(text) {
  if (!text) return null;
  const lines = text.split("\n").length;
  return `${lines} lines`;
}

function formatTool(tool, args) {
  if (tool === "write" && args?.path) return `write ${args.path}`;
  if (tool === "edit" && args?.path) return `edit ${args.path}`;
  const parts = [tool];
  if (args) {
    const vals = [];
    if (args.pattern) vals.push(args.pattern);
    else if (args.command) vals.push(fixDisplay(args.command).slice(0, 50));
    else if (args.question) vals.push(args.question.slice(0, 40));
    else if (args.path) vals.push(args.path);
    if (vals.length) parts.push(" ", vals.join(" "));
  }
  return parts.join("");
}

export function ToolCall({ tool, args, done, duration, resultSize }) {
  const [f, setF] = useState(0);
  useEffect(() => {
    if (done) return;
    const t = setInterval(() => setF(x => (x + 1) % FRAMES.length), 120);
    return () => clearInterval(t);
  }, [done]);

  const icon = done
    ? h(Text, { color: "green" }, "✓")
    : h(Text, { dimColor: true }, FRAMES[f]);

  const isWriteEdit = tool === "write" || tool === "edit";
  const label = !done && isWriteEdit
    ? `Preparing ${tool}...`
    : formatTool(tool, args);

  const meta = [];
  if (done && duration) meta.push(formatDuration(duration));
  if (done && resultSize) meta.push(formatSize(resultSize));

  return h(Box, { height: 1 },
    h(Text, {}, "  ", icon, " ", label),
    meta.length > 0 ? h(Text, { dimColor: true }, " (", meta.join(", "), ")") : null
  );
}
