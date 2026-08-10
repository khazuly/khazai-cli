import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement as h, Fragment } from "react";
import { Text, render } from "ink";
import { Agent } from "../app/agent.js";
import { Registry } from "../app/registry.js";
import { SessionStore } from "../app/session-store.js";
import { hydrateCanonicalMessages } from "../app/session-hydration.js";
import { HistoricalTranscript } from "../ui/components/historical-transcript.js";
import { appendVisibleHistory, recentHistoryWindow } from "../ui/history-window.js";
import { ThemeProvider } from "../ui/theme.js";
import { stripAnsi, TerminalInput, TerminalOutput } from "./helpers/ink-render.js";

function state(messages, extra = {}) {
  return {
    version: 5,
    sessionId: "performance-session",
    messages,
    summary: "",
    parts: [],
    contextUsage: { requests: [], sessionInputTokens: 300, sessionOutputTokens: 100, historyRevision: 0 },
    historyRevision: 0,
    contextRevision: 0,
    ...extra,
  };
}

function agent(messages, extra = {}) {
  return new Agent(new Registry(), {
    workspace: mkdtempSync(join(tmpdir(), "khazai-performance-agent-")),
    sessionId: "performance-session",
    model: "big-cock",
    config: { modelSettings: {}, models: {}, contextLimit: 128_000, tokenBudget: 24_000 },
    sessionState: state(messages, extra),
  });
}

test("a 1,000-message resume renders only the bounded recent window", () => {
  const messages = Array.from({ length: 1_000 }, (_, index) => ({ id: `message-${index}`, type: "answer", content: `answer ${index}` }));
  const visible = recentHistoryWindow(messages);
  assert.equal(visible.length, 21);
  assert.equal(visible[0].hiddenCount, 980);
  assert.equal(visible.at(-1), messages.at(-1));
});

test("messages appended after a bounded resume remain append-only and visible", async () => {
  const stored = Array.from({ length: 1_000 }, (_, index) => ({ id: `stored-${index}`, type: "answer", content: `stored ${index}` }));
  const resumed = recentHistoryWindow(stored, 2);
  const updates = [
    { id: "new-user", type: "user", content: "VISIBLE NEW USER" },
    { id: "new-tool", type: "tool", tool: "bash", callId: "new-call", args: { command: "echo visible" }, content: "VISIBLE TOOL RESULT", done: true },
    { id: "new-answer", type: "answer", content: "VISIBLE NEW ANSWER" },
  ];
  const visible = updates.reduce(appendVisibleHistory, resumed);
  assert.equal(visible.length, resumed.length + updates.length);
  assert.deepEqual(visible.slice(-3), updates);
  assert.equal(visible[0], resumed[0]);

  const stdout = new TerminalOutput(80, 30);
  const stdin = new TerminalInput();
  const view = items => h(ThemeProvider, { name: "dark" },
    h(HistoricalTranscript, { items, sessionKey: 1, model: "big-cock", workspace: "/tmp", agent: "build", autoApprove: false }));
  const instance = render(view(resumed), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
  await new Promise(resolve => setTimeout(resolve, 40));
  let current = resumed;
  for (const update of updates) {
    current = appendVisibleHistory(current, update);
    instance.rerender(view(current));
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  const rendered = stripAnsi(stdout.frames.join(""));
  assert.match(rendered, /VISIBLE NEW USER/);
  assert.match(rendered, /VISIBLE TOOL RESULT/);
  assert.match(rendered, /VISIBLE NEW ANSWER/);
  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});

test("live footer ticks do not rerender unchanged historical transcript rows", async () => {
  const stdout = new TerminalOutput(80, 30);
  const stdin = new TerminalInput();
  const items = [{ id: "history-answer", type: "answer", content: "IMMUTABLE HISTORY ROW" }];
  const view = tick => h(ThemeProvider, { name: "dark" }, h(Fragment, null,
    h(HistoricalTranscript, { items, sessionKey: 1, model: "big-cock", workspace: "/tmp", agent: "build", autoApprove: false }),
    h(Text, null, `tick ${tick}`),
  ));
  const instance = render(view(1), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
  await new Promise(resolve => setTimeout(resolve, 50));
  instance.rerender(view(2));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((stripAnsi(stdout.frames.join("")).match(/IMMUTABLE HISTORY ROW/g) || []).length, 1);
  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});

test("adding one message tokenizes only the new canonical message", () => {
  const messages = Array.from({ length: 1_000 }, (_, index) => ({ id: `message-${index}`, role: index % 2 ? "assistant" : "user", content: `content ${index}` }));
  const instance = agent(messages);
  instance.contextUsage();
  const before = instance._contextCache.stats.metaComputations;
  instance._appendMessage({ role: "user", content: "new content" });
  instance.contextUsage();
  assert.equal(instance._contextCache.stats.metaComputations - before, 1);
});

test("tool-call and result hydration builds stable linear indexes", () => {
  const messages = [];
  for (let index = 0; index < 5_000; index++) {
    messages.push({ id: `assistant-${index}`, role: "assistant", content: null, tool_calls: [{ id: `call-${index}`, type: "function", function: { name: "read", arguments: "{}" } }] });
    messages.push({ id: `result-${index}`, role: "tool", tool_call_id: `call-${index}`, name: "read", content: "result" });
  }
  const hydrated = hydrateCanonicalMessages(messages);
  assert.equal(hydrated.indexes.toolCallById.size, 5_000);
  assert.equal(hydrated.indexes.toolResultByCallId.size, 5_000);
  assert.equal(hydrated.indexes.toolCallById.get("call-4999").message.id, "assistant-4999");
});

test("a compacted session resumes directly from its saved checkpoint", () => {
  const messages = Array.from({ length: 100 }, (_, index) => ({ id: `message-${index}`, role: index % 2 ? "assistant" : "user", content: `content ${index} ${"x".repeat(200)}` }));
  const original = agent(messages);
  assert.equal(original._compactMessages(true), true);
  const saved = original.exportSessionState();
  const resumed = agent(messages, saved);
  assert.equal(resumed._summary, saved.compactedCheckpoint.summary);
  const last = resumed._messages.at(-1);
  assert.ok(
    String(last?.id) === "message-99" || last?.content === "Continue the active task.",
    `last message should be recent (got ${JSON.stringify(last?.content?.slice(0, 30))})`,
  );
  assert.ok(resumed._messages.length >= 2, "active tail survives resume");
});

test("compaction runs at most once for one context revision", () => {
  const messages = Array.from({ length: 100 }, (_, index) => ({ id: `message-${index}`, role: index % 2 ? "assistant" : "user", content: `content ${index}` }));
  const instance = agent(messages);
  assert.equal(instance._compactMessages(true), true);
  assert.equal(instance._compactMessages(true), false);
});

test("large tool results persist completely while initial rendering stays bounded", () => {
  const root = mkdtempSync(join(tmpdir(), "khazai-performance-store-"));
  const workspace = mkdtempSync(join(tmpdir(), "khazai-performance-workspace-"));
  try {
    const store = new SessionStore(workspace, root);
    const session = store.create();
    const content = Array.from({ length: 2_000 }, (_, index) => `line ${index}`).join("\n");
    session.messages = [{ id: "tool-large", type: "tool", tool: "bash", callId: "large", args: { command: "build" }, content, done: true, expanded: false }];
    store.save(session);
    const loaded = store.load(session.id);
    assert.equal(loaded.messages[0].content, content);
    assert.equal(recentHistoryWindow(loaded.messages)[0].content, content);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("repeated load of a cached session does not throw on hydrationTimings", () => {
  const root = mkdtempSync(join(tmpdir(), "khazai-performance-store-"));
  const workspace = mkdtempSync(join(tmpdir(), "khazai-performance-workspace-"));
  try {
    const store = new SessionStore(workspace, root);
    const session = store.create();
    store.save(session);
    const first = store.load(session.id);
    assert.ok(Object.prototype.hasOwnProperty.call(first, "hydrationTimings"));
    assert.equal(first.hydrationTimings.cacheHitMs, 0);
    const second = store.load(session.id);
    assert.equal(second.hydrationTimings.cacheHitMs, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("session usage remains cumulative and unique after resume", () => {
  const first = agent([], { contextUsage: { requests: [{ key: "run:turn:request", inputTokens: 20, outputTokens: 5 }], sessionInputTokens: 20, sessionOutputTokens: 5, historyRevision: 0 } });
  const resumed = agent([], first.exportSessionState());
  assert.equal(resumed.contextUsage().sessionInputTokens, 20);
  assert.equal(resumed.contextUsage().sessionOutputTokens, 5);
});

test("a stale checkpoint cannot replace newer canonical history", () => {
  const current = [{ id: "current", role: "user", content: "current" }];
  const stale = { contextRevision: 2, sourceRevision: 1, messages: [{ id: "stale", role: "user", content: "stale" }], summary: "stale", requestStartIndex: 0 };
  const resumed = agent(current, { contextRevision: 3, historyRevision: 3, compactedCheckpoint: stale });
  assert.equal(resumed._messages[0].content, "current");
});

test("small session history keeps its original identity and behavior", () => {
  const messages = [{ id: "one", type: "user", content: "hello" }, { id: "two", type: "answer", content: "hi" }];
  assert.equal(recentHistoryWindow(messages), messages);
});
