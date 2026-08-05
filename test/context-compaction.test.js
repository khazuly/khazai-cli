import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../app/agent.js";
import { Registry } from "../app/registry.js";
import { runScheduledCompaction } from "../app/agent/loop-compaction.js";

function agentWithState(state, overrides = {}) {
  return new Agent(new Registry(), {
    workspace: mkdtempSync(join(tmpdir(), "khazai-compact-")),
    config: { modelSettings: {}, models: {}, contextLimit: null, ...overrides },
    sessionState: state,
  });
}

test("automatic compaction keeps more recent context than manual compaction", () => {
  const messages = Array.from({ length: 10 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message-${index} ${"x".repeat(120)}`,
  }));
  const state = { messages, summary: "" };

  const automatic = agentWithState(state);
  automatic._config.tokenBudget = 240;
  automatic._config.compactThreshold = 1;
  assert.equal(automatic._compactMessages(), true);

  const manual = agentWithState(state);
  manual._config.tokenBudget = 240;
  manual._config.compactThreshold = 1;
  manual.compact();

  assert.ok(automatic._messages.length > manual._messages.length);
  assert.equal(automatic._messages.at(-1).content, messages.at(-1).content);
  assert.equal(manual._messages.at(-1).content, messages.at(-1).content);
});

test("unknown context limits omit percentages and disable threshold compaction", () => {
  const messages = Array.from({ length: 6 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message-${index} ${"x".repeat(180)}`,
  }));
  const agent = agentWithState({ messages, summary: "" });
  const usage = agent.contextUsage();
  assert.equal(usage.contextLimitKnown, false);
  assert.equal(usage.usagePercent, null);
  assert.ok(usage.currentContextTokens > 0);
  assert.equal(agent.compactIfNeeded(), false);
});

test("known context limits compact from projected request usage", () => {
  const messages = Array.from({ length: 4 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message-${index} ${"x".repeat(180)}`,
  }));
  const state = { messages, summary: "" };
  const usage = agentWithState(state).contextUsage();
  const agent = new Agent(new Registry(), {
    workspace: mkdtempSync(join(tmpdir(), "khazai-compact-known-")),
    config: {
      modelSettings: {},
      models: {},
      contextLimit: usage.projectedRequestTokens,
      compactThreshold: 1,
    },
    sessionState: state,
  });
  assert.equal(agent.contextUsage().contextLimitKnown, true);
  assert.equal(agent.compactIfNeeded(), true);
});

test("context building preserves assistant tool calls before tool results", () => {
  const state = {
    messages: [
      { role: "user", content: "please inspect" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call-1",
          type: "function",
          function: { name: "read", arguments: JSON.stringify({ path: "file.js" }) },
        }],
      },
      { role: "tool", tool_call_id: "call-1", name: "read", content: "content" },
    ],
    summary: "",
  };
  const agent = agentWithState(state);
  agent._config.tokenBudget = 50;

  const context = agent._buildContext();
  const roles = context.map(message => message.role);
  const toolIndex = roles.indexOf("tool");

  assert.ok(toolIndex > 0);
  assert.equal(context[toolIndex - 1].role, "assistant");
  assert.ok(context[toolIndex - 1].tool_calls);
});

test("superseded runs clear their pending compaction so the next run can schedule", () => {
  const messages = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message-${index} ${"x".repeat(180)}`,
  }));
  const agent = agentWithState({ messages, summary: "" }, { contextLimit: 40_000 });
  const first = { runId: "run-1", turnId: "turn-1", taskEpoch: 1 };
  agent._activeRun = { ...first, cancelled: false, finalized: false };
  assert.equal(agent._scheduleCompaction(first, "threshold"), true);
  const second = { runId: "run-2", turnId: "turn-2", taskEpoch: 2 };
  agent._activeRun = { ...second, cancelled: false, finalized: false };
  assert.equal(agent._scheduleCompaction(second, "emergency"), true);
  assert.equal(agent._compaction.runId, "run-2");
});

test("scheduled compaction invalidates cached provider projections", async () => {
  const messages = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message-${index} ${"x".repeat(400)}`,
  }));
  const agent = agentWithState({ messages, summary: "" }, { contextLimit: 800 });
  const model = agent._model;
  const key = [
    agent._contextCacheKey(),
    `m:${model}`,
    `t:${agent._registry.revision}`,
    `c:${agent._providerCapabilityRevision || 0}`,
  ].join("|");
  const ctx = agent._frame().messages;
  await agent._projectProviderPayload(ctx, [], model);
  assert.ok(agent._contextCache.projection(key), "projection is cached before compaction");
  const run = { runId: "run-1", turnId: "turn-1", taskEpoch: 1 };
  agent._activeRun = { ...run, cancelled: false, finalized: false };
  assert.equal(agent._scheduleCompaction(run, "threshold"), true);
  const gen = runScheduledCompaction.call(agent, run, {
    isRunActive: () => true,
    scoped: event => event,
    finalizeRun: () => true,
  });
  for (let index = 0; index < 30; index++) {
    const { done } = await gen.next();
    if (done) break;
  }
  assert.equal(agent._contextCache.projection(key), null);
});

test("compaction summary keeps the accumulated summary before newer transcript", () => {
  const messages = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message-${index} ${"x".repeat(400)}`,
  }));
  const oldSummary = `OLD-SUMMARY:${"A".repeat(3000)}`;
  const agent = agentWithState({ messages, summary: oldSummary }, { contextLimit: 400 });
  const built = agent._buildCompactedMessages(true);
  assert.ok(built.summary.includes("OLD-SUMMARY:"), "prior summary survives truncation");
  assert.ok(built.summary.includes("message-"), "new transcript is appended");
});

test("superseded compaction never reports completed and restores messages", async () => {
  const messages = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message-${index} ${"x".repeat(400)}`,
  }));
  const agent = agentWithState({ messages, summary: "" }, { contextLimit: 40_000 });
  const run = { runId: "run-1", turnId: "turn-1", taskEpoch: 1 };
  agent._activeRun = { ...run, cancelled: false, finalized: false };
  assert.equal(agent._scheduleCompaction(run, "emergency"), true);
  let active = true;
  const gen = runScheduledCompaction.call(agent, run, {
    isRunActive: () => active,
    scoped: event => event,
    finalizeRun: () => false,
  });
  const statuses = [];
  for (let index = 0; index < 30; index++) {
    const { value, done } = await gen.next();
    if (value?.type === "compaction-state") statuses.push(value.status);
    if (done) break;
    if (statuses.length === 1) active = false;
  }
  assert.ok(statuses.includes("failed"), "superseded compaction reports failed");
  assert.ok(!statuses.includes("completed"), "superseded compaction never reports completed");
  assert.equal(agent._messages.length, messages.length, "messages are restored");
});

test("threshold compaction preserves recent turns and folds older history into the summary", async () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message-${index} ${"x".repeat(200)}`,
  }));
  const agent = agentWithState({ messages, summary: "" }, { contextLimit: 1500 });
  const run = { runId: "run-1", turnId: "turn-1", taskEpoch: 1 };
  agent._activeRun = { ...run, cancelled: false, finalized: false };
  assert.equal(agent._scheduleCompaction(run, "threshold"), true);
  const gen = runScheduledCompaction.call(agent, run, {
    isRunActive: () => true,
    scoped: event => event,
    finalizeRun: () => true,
  });
  for (let index = 0; index < 30; index++) {
    const { done } = await gen.next();
    if (done) break;
  }
  assert.ok(agent._messages.length < messages.length, "threshold compaction reduces history");
  assert.ok(agent._messages.length >= 4, "recent turns survive verbatim");
  assert.equal(agent._messages.at(-1).content, messages.at(-1).content);
  assert.ok(agent._summary.includes("message-0"), "older history is folded into the summary");
});
