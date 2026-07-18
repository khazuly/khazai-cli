import { createElement as h } from "react";
import { Text, Box } from "ink";
import { useEffect, useState } from "react";
import { toolTarget } from "../tool-presentation.js";
import { useTheme } from "../theme.js";

const WORKING_INTERVAL_MS = 1_000;

const ACTIVE_LABELS = {
  read: "Reading",
  glob: "Searching",
  grep: "Searching",
  websearch: "Searching web",
  webfetch: "Fetching",
  repo: "Inspecting repository",
  write: "Writing",
  edit: "Editing",
  apply_patch: "Applying patch",
  bash: "Running",
  analyze: "Analyzing",
  task: "Delegating",
};

export function StatusBar({ running, plan = [], activeTool = null, startedAt = null }) {
  const [frame, setFrame] = useState(0);
  const theme = useTheme();

  useEffect(() => {
    if (!running) return undefined;
    setFrame(0);
    const timer = setInterval(() => setFrame(current => current + 1), WORKING_INTERVAL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [running]);

  if (!running) return null;

  const activePlan = plan.findIndex(item => item.status === "running");
  const target = activeTool ? toolTarget(activeTool.tool, activeTool.args).split("\n")[0] : "";
  const action = activeTool
    ? ACTIVE_LABELS[activeTool.tool] || "Working"
    : activePlan >= 0 ? `Working ${activePlan + 1}/${plan.length}` : "Working";
  const elapsed = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : frame;
  return h(Box, { marginBottom: 0, paddingLeft: 1 },
    h(Text, { bold: true, color: theme.primary }, action),
    target ? h(Text, { color: theme.toolTarget, wrap: "truncate-end" }, "  ", target) : null,
    h(Text, { color: theme.metadata }, `  ${elapsed}s · Esc cancel`),
  );
}
