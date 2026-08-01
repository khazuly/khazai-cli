import { createElement as h, useEffect, useRef, useState } from "react";
import { Text, Box } from "ink";
import stringWidth from "string-width";
import { SPINNER_FRAMES } from "./status-bar.js";
import { useTheme } from "../theme.js";

const ACTIVITY_VERB_FORMS = {
  add: "Adding", adjust: "Adjusting", allow: "Allowing", analyze: "Analyzing",
  answer: "Answering", append: "Appending", apply: "Applying", ask: "Asking",
  assert: "Asserting", avoid: "Avoiding", build: "Building", cancel: "Cancelling",
  check: "Checking", clear: "Clearing", close: "Closing", configure: "Configuring",
  confirm: "Confirming", copy: "Copying", create: "Creating", delete: "Deleting",
  derive: "Deriving", display: "Displaying", edit: "Editing", ensure: "Ensuring",
  expose: "Exposing", extract: "Extracting", fetch: "Fetching", finalize: "Finalizing",
  fix: "Fixing", format: "Formatting", generate: "Generating", guard: "Guarding",
  handle: "Handling", implement: "Implementing", improve: "Improving", inspect: "Inspecting",
  install: "Installing", keep: "Keeping", limit: "Limiting", load: "Loading",
  log: "Logging", make: "Making", match: "Matching", merge: "Merging",
  move: "Moving", notify: "Notifying", open: "Opening", parse: "Parsing",
  plan: "Planning", prepare: "Preparing", prevent: "Preventing", print: "Printing",
  provide: "Providing", read: "Reading", refactor: "Refactoring", remove: "Removing",
  rename: "Renaming", render: "Rendering", replace: "Replacing", require: "Requiring",
  reset: "Resetting", restructure: "Restructuring", retry: "Retrying", reuse: "Reusing",
  review: "Reviewing", run: "Running", save: "Saving", search: "Searching",
  select: "Selecting", send: "Sending", show: "Showing", simplify: "Simplifying",
  stop: "Stopping", store: "Storing", switch: "Switching", test: "Testing",
  track: "Tracking", trim: "Trimming", update: "Updating", use: "Using",
  validate: "Validating", verify: "Verifying", wait: "Waiting", watch: "Watching",
  write: "Writing",
};

const ACTIVITY_DETAIL_MARKERS = [
  "exactly", "once", "after", "before", "while", "when", "using", "via",
  "with", "on", "at", "for", "and", "or",
];

const FILE_PREFIX_PATTERN = /^(?:[./]*[\w@][\w@./-]*\.(?:js|ts|jsx|tsx|mjs|cjs|py|rs|go|rb|sh|md|json|css|html|yml|yaml|toml))[\s:—-]+\s*/i;

function activityFirstWord(text) {
  return String(text || "").split(/\s+/, 1)[0]?.toLowerCase().replace(/[^a-z]/g, "") || "";
}

export function deriveActivityLabel(title, maximum = 48) {
  let text = String(title || "").replace(/\s+/g, " ").trim();
  if (!text) return "Working";
  const stripped = text.replace(FILE_PREFIX_PATTERN, "");
  const first = activityFirstWord(stripped);
  if (first && (ACTIVITY_VERB_FORMS[first] || first.endsWith("ing") || first.endsWith("ed"))) {
    text = stripped;
  }
  let words = text.split(/[(:;,]/)[0].trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    const marker = words.findIndex(word => ACTIVITY_DETAIL_MARKERS.includes(word.toLowerCase()));
    if (marker > 0) words = words.slice(0, marker);
  }
  text = words.join(" ");
  if (!text) return "Working";
  const verb = ACTIVITY_VERB_FORMS[words[0].toLowerCase().replace(/[^a-z]/g, "")];
  const remainder = words.slice(1).join(" ");
  text = verb
    ? `${verb}${remainder ? ` ${remainder}` : ""}`
    : `${words[0][0].toUpperCase()}${words[0].slice(1)}${remainder ? ` ${remainder}` : ""}`;
  if (stringWidth(text) > maximum) {
    const budget = Math.max(1, maximum - 1);
    const cut = text.slice(0, budget);
    const boundary = cut.lastIndexOf(" ");
    text = `${(boundary > 0 ? cut.slice(0, boundary) : cut).trim()}…`;
  }
  return text;
}

export function workingShimmerMask(frame = 0, text = "Working") {
  const length = text.length;
  if (length === 0) return [];
  const highlighted = frame % length;
  return [...text].map((_character, index) => (
    index === highlighted || index === (highlighted + 1) % length
  ));
}

export function TextShimmer({ text = "Working", frame = 0, intervalMs = 70 }) {
  const theme = useTheme();
  const colorEnabled = theme.colorEnabled !== false;
  const mask = workingShimmerMask(frame, text);
  return h(Text, null,
    ...[...text].map((character, index) => {
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

export function WorkingShimmer({ frame = 0 }) {
  return h(TextShimmer, { text: "Working", frame });
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
  const initGenerating = modeStatus?.mode === "init" && modeStatus.status === "generating";
  const animating = compacting || genericWorking || initGenerating;
  const scopeKey = [
    activityScope?.runId || "",
    activityScope?.turnId || "",
    activityScope?.taskEpoch ?? "",
  ].join(":");
  const animationKey = `${scopeKey}:${compactionStatus}:${genericWorking ? "working" : "idle"}:${initGenerating ? "init-generating" : "idle"}`;
  scopeRef.current = animationKey;

  useEffect(() => {
    setFrame(0);
    if (!animating) return undefined;
    const expectedScope = animationKey;
    const intervalMs = initGenerating ? 70 : 150;
    const timer = setInterval(() => {
      if (scopeRef.current !== expectedScope) return;
      setFrame(v => v + 1);
      if (compacting) setNow(Date.now());
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [animationKey, compacting, genericWorking, initGenerating, animating]);

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
    if (["ready", "awaiting"].includes(modeStatus.status)) return null;
    const phase = modeStatus.status === "clarifying"
      ? "Waiting for decision"
      : modeStatus.status === "drafting"
        ? "Drafting plan"
        : modeStatus.status === "entering"
          ? "Preparing"
          : "Exploring";
    activityText = `Plan Mode · ${phase}${queue}`;
  } else if (modeStatus?.mode === "init") {
    if (initGenerating) {
      activityContent = h(Box, null,
        h(TextShimmer, { text: "Generating AGENTS.md", frame, intervalMs: 70 }),
        queue ? h(Text, { color: theme.muted }, queue) : null,
      );
    } else {
      const phase = modeStatus.status === "reviewing"
        ? "Reviewing project conventions"
        : modeStatus.status === "preparing"
          ? "Preparing preview"
          : "Inspecting repository structure";
      activityText = `${phase}${queue}`;
    }
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
