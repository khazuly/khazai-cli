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
    chat: async (_messages, options) => options.streamPhase === "compaction"
      ? "Goal\nPreserve message-0 and continue the active task."
      : "Done.",
  });
}

test("automatic compaction keeps more recent context than manual compaction", async () => {
  const messages = Array.from({ length: 10 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message-${index} ${"x".repeat(120)}`,
  }));
  const state = { messages, summary: "" };

  const automatic = agentWithState(state);
  automatic._config.tokenBudget = 240;
  automatic._config.compactThreshold = 1;
  automatic._config.compactionSoftLimit = 1;
  assert.equal(automatic._compactMessages(), true);

  const manual = agentWithState(state);
  manual._config.tokenBudget = 240;
  manual._config.compactThreshold = 1;
  await manual.compact();

  assert.ok(automatic._tailStartIndex < manual._tailStartIndex || automatic._summary.length > 0);
  const automaticLast = automatic._messages.at(-1).content;
  assert.ok(
    automaticLast === messages.at(-1).content || automaticLast === "Continue the active task.",
    `automatic last message should be recent (got "${automaticLast}")`,
  );
  const manualLast = manual._messages.at(-1).content;
  assert.ok(
    manualLast === messages.at(-1).content || manualLast === "Continue the active task.",
    `manual last message should be recent (got "${manualLast}")`,
  );
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

test("an explicit soft limit compacts before a larger model window", () => {
  const messages = Array.from({ length: 80 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message-${index} ${"x".repeat(1_600)}`,
  }));
  const agent = agentWithState({ messages, summary: "" }, {
    contextLimit: 128_000,
    compactionSoftLimit: 30_000,
  });
  const usage = agent.contextUsage();
  assert.ok(usage.projectedRequestTokens >= 30_000);
  assert.equal(agent._shouldCompactUsage(usage), true);
});

test("a model context limit remains the default compaction limit", () => {
  const messages = Array.from({ length: 80 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message-${index} ${"x".repeat(1_600)}`,
  }));
  const agent = agentWithState({ messages, summary: "" }, { contextLimit: 128_000 });
  const usage = agent.contextUsage();
  assert.equal(agent._config.compactionSoftLimit, null);
  assert.equal(agent._shouldCompactUsage(usage), false);
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
  const headBudget = Math.floor(agent._maxSummaryChars() * 0.5);
  assert.ok(built.summary.includes("OLD-SUMMARY:"), "prior summary survives truncation");
  assert.ok(
    built.summary.includes("message-") || built.summary.length >= headBudget,
    "new transcript is appended",
  );
});

test("model compaction receives a structured handoff prompt without tool schemas", async () => {
  const messages = Array.from({ length: 10 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message-${index}`,
  }));
  let request;
  const agent = agentWithState({ messages, summary: "prior decision" }, { contextLimit: 2_000 });
  agent._currentRequest = "finish the implementation";
  agent._chat = async (input, options) => {
    request = { input, options };
    return "Goal\nfinish the implementation\nNext Step\nrun tests";
  };
  const candidate = agent._buildCompactedMessages(true);
  const summary = await agent._summarizeCompaction(candidate, new AbortController().signal);
  assert.match(request.input[0].content, /Previous rolling summary:\nprior decision/);
  assert.match(request.input[0].content, /Objective: finish the implementation/);
  assert.match(request.input[0].content, /Completed and Evidence/);
  assert.deepEqual(request.options.tools, []);
  assert.match(summary, /Next Step/);
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

test("failed model summary commits the local fallback and continues", async () => {
  const messages = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message-${index} ${"x".repeat(400)}`,
  }));
  const agent = agentWithState({ messages, summary: "stable" }, { contextLimit: 2_000 });
  agent._chat = async () => { throw new Error("summary unavailable"); };
  const run = { runId: "run-fail", turnId: "turn-fail", taskEpoch: 1 };
  agent._activeRun = { ...run, cancelled: false, finalized: false };
  assert.equal(agent._scheduleCompaction(run, "threshold"), true);
  const events = [];
  for await (const event of runScheduledCompaction.call(agent, run, {
    isRunActive: () => true,
    scoped: value => value,
    finalizeRun: () => true,
  })) events.push(event);
  assert.notEqual(agent._summary, "stable");
  assert.ok(agent._tailStartIndex > 0);
  assert.ok(events.some(event => event.status === "completed" && event.fallback));
  assert.ok(!events.some(event => event.status === "failed"));
});

test("manual compaction falls back when the provider summary fails", async () => {
  const messages = Array.from({ length: 10 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message-${index} ${"x".repeat(400)}`,
  }));
  const agent = agentWithState({ messages, summary: "stable" }, { contextLimit: 2_000 });
  agent._chat = async () => { throw new Error("summary unavailable"); };
  await agent.compact();
  assert.notEqual(agent._summary, "stable");
  assert.ok(agent._tailStartIndex > 0);
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
  assert.equal(agent._messages.length, messages.length, "durable transcript remains complete");
  assert.ok(agent._tailStartIndex > 0, "active model frame starts at the recent tail");
  const lastContent = agent._messages.at(-1).content;
  assert.ok(
    lastContent === messages.at(-1).content || lastContent === "Continue the active task.",
    `last message should be recent (got "${lastContent}")`,
  );
  assert.ok(agent._summary.includes("message-0"), "older history is folded into the summary");
});
