import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h } from "react";
import { render } from "ink";
import { deriveActivityLabel, workingShimmerMask } from "../ui/components/activity-bar.js";
import { SessionFooter } from "../ui/components/session-footer.js";
import { SPINNER_FRAMES } from "../ui/components/status-bar.js";
import { renderComponent, TerminalInput, TerminalOutput, stripAnsi } from "./helpers/ink-render.js";

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

test("init mode shows only the four high-level activity phases", async () => {
  const inspecting = await renderComponent(h(SessionFooter, {
    running: true,
    modeStatus: { mode: "init", status: "inspecting" },
    model: "big-cock",
    contextUsage: { currentContextTokens: 14, contextLimit: 100 },
    promptProps,
  }), 72, 12);
  assert.match(inspecting, /Inspecting repository structure/);
  assert.doesNotMatch(inspecting, /Working/);

  const reviewing = await renderComponent(h(SessionFooter, {
    running: true,
    modeStatus: { mode: "init", status: "reviewing" },
    model: "big-cock",
    contextUsage: { currentContextTokens: 14, contextLimit: 100 },
    promptProps,
  }), 72, 12);
  assert.match(reviewing, /Reviewing project conventions/);

  const generating = await renderComponent(h(SessionFooter, {
    running: true,
    modeStatus: { mode: "init", status: "generating" },
    model: "big-cock",
    contextUsage: { currentContextTokens: 14, contextLimit: 100 },
    promptProps,
  }), 72, 12);
  assert.match(generating, /Generating AGENTS\.md/);

  const preparing = await renderComponent(h(SessionFooter, {
    running: true,
    modeStatus: { mode: "init", status: "preparing" },
    model: "big-cock",
    contextUsage: { currentContextTokens: 14, contextLimit: 100 },
    promptProps,
  }), 72, 12);
  assert.match(preparing, /Preparing preview/);
});

test("the AGENTS.md shimmer stops as soon as generation finalizes", async () => {
  const idle = await renderComponent(h(SessionFooter, {
    running: true,
    modeStatus: null,
    model: "big-cock",
    contextUsage: { currentContextTokens: 14, contextLimit: 100 },
    promptProps,
  }), 72, 12);
  assert.doesNotMatch(idle, /Generating AGENTS\.md/);

  const waiting = await renderComponent(h(SessionFooter, {
    running: false,
    modeStatus: null,
    model: "big-cock",
    contextUsage: { currentContextTokens: 14, contextLimit: 100 },
    promptProps,
  }), 72, 12);
  assert.doesNotMatch(waiting, /Generating AGENTS\.md/);
});

test("one hundred animation frames still produce only one ActivityBar row", async () => {
  for (let frame = 0; frame < 100; frame++) {
    const mask = workingShimmerMask(frame, "Working");
    assert.equal(mask.length, 7);
    assert.equal(mask.filter(Boolean).length, 2);
  }
  const stdout = new TerminalOutput(72, 14);
  const stdin = new TerminalInput();
  const instance = render(h(SessionFooter, {
    running: true,
    modeStatus: { mode: "init", status: "generating" },
    model: "big-cock",
    contextUsage: { currentContextTokens: 14, contextLimit: 100 },
    promptProps,
  }), { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false });
  await new Promise(resolve => setTimeout(resolve, 420));
  const frames = stdout.frames.map(frame => stripAnsi(frame).replace(/\r/g, "")).filter(frame => frame.trim());
  assert.ok(frames.length >= 4, `expected several shimmer frames, got ${frames.length}`);
  for (const frame of frames) {
    assert.equal((frame.match(/Generating AGENTS\.md/g) || []).length, 1, frame);
    assert.equal((frame.match(/Esc cancel/g) || []).length, 1, frame);
  }
  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});

test("elapsed-time updates never append conversation or activity rows", async () => {
  const startedAt = Date.now() - 5 * 60_000;
  const stdout = new TerminalOutput(72, 14);
  const stdin = new TerminalInput();
  const instance = render(h(SessionFooter, {
    running: true,
    contextUsage: {
      currentContextTokens: 91_000,
      contextLimit: 100_000,
      compactionStatus: "summarizing",
      compactionStartedAt: startedAt,
    },
    model: "big-cock",
    promptProps,
  }), { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false });
  await new Promise(resolve => setTimeout(resolve, 1_350));
  const frames = stdout.frames.map(frame => stripAnsi(frame).replace(/\r/g, "")).filter(frame => frame.trim());
  assert.ok(frames.length >= 8, `expected elapsed ticks, got ${frames.length}`);
  for (const frame of frames) {
    assert.equal((frame.match(/Compacting context/g) || []).length, 1, frame);
    assert.equal((frame.match(/Ask anything\.\.\./g) || []).length, 1, frame);
  }
  const times = frames.map(frame => (frame.match(/Compacting context · (\d+s)/) || [])[1]).filter(Boolean);
  assert.ok(times.length >= 2, "elapsed seconds must tick without appending rows");
  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});

test("ActivityBar displays a concise derived label that never wraps", () => {
  const label = deriveActivityLabel(
    "session.js: finalize init generation exactly once at finish event, stop shimmer immediately"
  );
  assert.equal(label, "Finalizing init generation");
  assert.ok(label.length <= 48);
  assert.ok(!label.includes("\n"));
  assert.equal(deriveActivityLabel("Fix parseInitResult: fenced and plain Markdown extraction"), "Fixing parseInitResult");
  assert.equal(deriveActivityLabel("session.js: restructure finalizer and state transition"), "Restructuring finalizer");
  for (let frame = 0; frame < 100; frame++) {
    assert.equal(deriveActivityLabel("session.js: finalize init generation exactly once at finish event, stop shimmer immediately"), label);
  }
});

test("prompt input and footer remain stationary while activity ticks", async () => {
  const startedAt = Date.now() - 12_000;
  const renderFooter = () => renderComponent(h(SessionFooter, {
    running: true,
    contextUsage: {
      currentContextTokens: 91_000,
      contextLimit: 100_000,
      compactionStatus: "summarizing",
      compactionStartedAt: startedAt,
    },
    model: "big-cock",
    promptProps,
  }), 72, 14);
  const first = await renderFooter();
  await new Promise(resolve => setTimeout(resolve, 250));
  const second = await renderFooter();
  const promptLine = frame => frame.split("\n").find(line => line.includes("Ask anything...")) || "";
  const footerLine = frame => frame.split("\n").find(line => line.includes("big-cock")) || "";
  assert.ok(promptLine(first));
  assert.equal(promptLine(first), promptLine(second));
  assert.equal(footerLine(first), footerLine(second));
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
