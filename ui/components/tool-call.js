import { createElement as h } from "react";
import { Text, Box } from "ink";
import { useState, useEffect } from "react";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function formatTool(tool, args) {
  const parts = [tool];
  if (args) {
    const vals = [];
    if (args.pattern) vals.push(args.pattern);
    else if (args.command) vals.push(args.command.slice(0, 40));
    else if (args.question) vals.push(args.question.slice(0, 40));
    else if (args.path) vals.push(args.path);
    if (vals.length) parts.push(" ", vals.join(" "));
  }
  return parts.join("");
}

export function ToolCall({ tool, args, done }) {
  const [f, setF] = useState(0);
  useEffect(() => {
    if (done) return;
    const t = setInterval(() => setF(x => (x + 1) % FRAMES.length), 120);
    return () => clearInterval(t);
  }, [done]);

  const icon = done
    ? h(Text, {}, "✓")
    : h(Text, { dimColor: true }, FRAMES[f]);

  const label = formatTool(tool, args);
  return h(Box, { height: 1 },
    h(Text, {}, "  ", icon, " [", label, "]")
  );
}
