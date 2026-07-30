import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h } from "react";
import { workingShimmerMask } from "../ui/components/activity-bar.js";
import { SessionFooter } from "../ui/components/session-footer.js";
import { SPINNER_FRAMES } from "../ui/components/status-bar.js";
import { renderComponent } from "./helpers/ink-render.js";

const promptProps = { onSubmit() {}, onCommand() {}, commands: [] };

test("generic Working shimmers without a spinner or duration", async () => {
  const frame = await renderComponent(h(SessionFooter, {
    running: true,
    model: "big-cock",
    contextUsage: { currentContextTokens: 14, contextLimit: 100 },
    promptProps: { ...promptProps, canAbort: true },
  }), 72, 14);
  const promptIndex = frame.indexOf("Ask anything...");
  assert.ok(promptIndex >= 0);
  assert.match(frame, /Working/);
  assert.doesNotMatch(frame, new RegExp(`[${SPINNER_FRAMES.join("")}]`));
  assert.doesNotMatch(frame, /Working · \d+s/);
  assert.equal(frame.match(/Esc cancel/g)?.length, 1);
  assert.ok(frame.indexOf("Working") < promptIndex);
  assert.ok(frame.indexOf("Esc cancel") < promptIndex);
  assert.equal(frame.match(/big-cock/g)?.length, 1);
  assert.ok(frame.indexOf("big-cock") > promptIndex);
  assert.ok(frame.indexOf("Context 14 / 100 · 14%") > promptIndex);
});

test("generic Working keeps fixed width while its highlight advances", () => {
  const first = workingShimmerMask(0);
  const second = workingShimmerMask(1);
  assert.equal(first.length, "Working".length);
  assert.equal(first.filter(Boolean).length, 2);
  assert.equal(second.filter(Boolean).length, 2);
  assert.notDeepEqual(first, second);
});

test("specific activity suppresses only the generic Working fallback", async () => {
  const frame = await renderComponent(h(SessionFooter, {
    running: true,
    hasSpecificActivity: true,
    model: "big-cock",
    contextUsage: { currentContextTokens: 14, contextLimit: 100 },
    promptProps,
  }), 72, 12);
  assert.doesNotMatch(frame, /Working/);
  assert.match(frame, /big-cock/);
});

test("idle, queued, compaction, and unknown context layouts remain intact", async () => {
  const idle = await renderComponent(h(SessionFooter, {
    model: "big-cock",
    contextUsage: { currentContextTokens: 14, contextLimit: 100 },
    promptProps,
  }), 72, 12);
  assert.match(idle, /big-cock · Enter send/);
  assert.match(idle, /Context 14 \/ 100 · 14%/);
  assert.doesNotMatch(idle, /Working|Esc cancel/);

  const queued = await renderComponent(h(SessionFooter, {
    running: true,
    queueCount: 2,
    model: "big-cock",
    contextUsage: { currentContextTokens: 14, contextLimit: 100 },
    promptProps,
  }), 42, 14);
  assert.match(queued, /Working · 2 queued/);
  assert.ok(queued.indexOf("2 queued") < queued.indexOf("Ask anything..."));
  assert.ok(queued.indexOf("Context 14 / 100 · 14%") > queued.indexOf("Ask anything..."));

  const compacting = await renderComponent(h(SessionFooter, {
    running: true,
    model: "big-cock",
    contextUsage: {
      currentContextTokens: 91_000,
      contextLimit: 100_000,
      compactionStatus: "summarizing",
      compactionStartedAt: Date.now(),
    },
    promptProps,
  }), 72, 12);
  assert.match(compacting, /⠋ Compacting context|⠙ Compacting context/);
  assert.ok(compacting.indexOf("Compacting context") < compacting.indexOf("Ask anything..."));
  assert.ok(compacting.indexOf("Context 91.0k / 100k · 91%") > compacting.indexOf("Ask anything..."));

  const unknown = await renderComponent(h(SessionFooter, {
    model: "big-cock",
    contextUsage: { currentContextTokens: 48_300, contextLimitKnown: false },
    promptProps,
  }), 72, 12);
  assert.match(unknown, /Context 48\.3k/);
  assert.doesNotMatch(unknown, /Context \d+%/);
});
