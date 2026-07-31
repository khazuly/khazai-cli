import { createElement as h, useEffect, useRef, useState } from "react";
import { Text, Box } from "ink";
import { SPINNER_FRAMES } from "./status-bar.js";
import { useTheme } from "../theme.js";

const WORKING_TEXT = "Working";

export function workingShimmerMask(frame = 0) {
  const highlighted = frame % WORKING_TEXT.length;
  return [...WORKING_TEXT].map((_character, index) => (
    index === highlighted || index === (highlighted + 1) % WORKING_TEXT.length
  ));
}

export function WorkingShimmer({ frame = 0 }) {
  const theme = useTheme();
  const colorEnabled = theme.colorEnabled !== false;
  const mask = workingShimmerMask(frame);
  return h(Text, null,
    ...[...WORKING_TEXT].map((character, index) => {
      const active = mask[index];
      return h(Text, {
        key: index,
        bold: active,
        dimColor: !colorEnabled && !active,
        color: colorEnabled ? (active ? theme.primary : theme.muted) : undefined,
      }, character);
    }),
  );
}

export function ActivityBar({
  running = false,
  waitingForAnswer = false,
  queueCount = 0,
  modeStatus = null,
  contextUsage = {},
  hasSpecificActivity = false,
  activityScope = null,
}) {
  const theme = useTheme();
  const [frame, setFrame] = useState(0);
  const [now, setNow] = useState(Date.now());
  const scopeRef = useRef("");

  const {
    compactionStatus = "idle",
    compactionStartedAt = null,
  } = contextUsage;

  const compacting = ["scheduled", "preparing", "summarizing", "committing", "recounting"]
    .includes(compactionStatus);
  const genericWorking = running
    && !waitingForAnswer
    && !compacting
    && !modeStatus
    && !hasSpecificActivity;
  const scopeKey = [
    activityScope?.runId || "",
    activityScope?.turnId || "",
    activityScope?.taskEpoch ?? "",
  ].join(":");
  const animationKey = `${scopeKey}:${compactionStatus}:${genericWorking ? "working" : "idle"}`;
  scopeRef.current = animationKey;

  useEffect(() => {
    setFrame(0);
    if (!compacting && !genericWorking) return undefined;
    const expectedScope = animationKey;
    const timer = setInterval(() => {
      if (scopeRef.current !== expectedScope) return;
      setFrame(v => v + 1);
      if (compacting) setNow(Date.now());
    }, 150);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [animationKey, compacting, genericWorking]);

  if (!running && !waitingForAnswer) return null;

  const queue = queueCount > 0 ? ` · ${queueCount} queued` : "";
  let activityText = "";
  let activityContent = null;

  if (compacting) {
    const label = ["scheduled", "preparing"].includes(compactionStatus)
      ? "Preparing compaction"
      : compactionStatus === "summarizing"
        ? `${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} Compacting context`
        : compactionStatus === "committing"
          ? "Committing compacted context"
          : "Recalculating context";
    const elapsed = compactionStartedAt
      ? Math.max(0, Math.floor((now - compactionStartedAt) / 1_000))
      : null;
    activityText = elapsed !== null ? `${label} · ${elapsed}s` : label;
  } else if (modeStatus?.mode === "plan") {
    const phase = modeStatus.status === "questioning"
      ? "Waiting for decision"
      : modeStatus.status === "reviewing"
        ? "Reviewing implementation"
        : "Investigating";
    activityText = `Plan Mode · ${phase}${queue}`;
  } else if (modeStatus?.mode === "init") {
    const phase = modeStatus.status === "reviewing"
      ? "Reviewing project conventions"
      : modeStatus.status === "generating"
        ? "Generating AGENTS.md"
        : modeStatus.status === "preparing"
          ? "Preparing preview"
          : "Inspecting repository structure";
    activityText = `${phase}${queue}`;
  } else if (modeStatus?.mode === "build") {
    const phase = modeStatus.status === "verifying"
      ? "Running verification"
      : modeStatus.status === "implementing"
        ? "Implementing approved plan"
        : "Preparing approved plan";
    activityText = `Build Mode · ${phase}${queue}`;
  } else if (waitingForAnswer) {
    activityText = `Action required · Waiting for approval${queue}`;
  } else if (genericWorking) {
    activityContent = h(Text, { wrap: "truncate-end" },
      h(WorkingShimmer, { frame }),
      queue ? h(Text, { color: theme.muted }, queue) : null,
    );
  }

  if (!activityText && !activityContent) return null;

  return h(Box, { width: "100%" },
    h(Box, { flexGrow: 1, minWidth: 0 },
      activityContent
        || h(Text, { color: theme.primary, wrap: "truncate-end" }, activityText),
    ),
    h(Box, { marginLeft: 2, flexShrink: 0 },
      h(Text, { color: theme.muted }, "Esc cancel"),
    ),
  );
}
