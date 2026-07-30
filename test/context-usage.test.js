import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../app/agent.js";
import {
  ContextUsageTracker,
  countProviderContext,
  resolveContextLimit,
} from "../app/context-usage.js";
import { Registry } from "../app/registry.js";

test("request usage replaces duplicate updates while session totals stay cumulative", () => {
  const tracker = new ContextUsageTracker();
  const first = { runId: "run-1", turnId: "turn-1" };
  const second = { runId: "run-2", turnId: "turn-2" };
  tracker.record({ requestId: "request-1", inputTokens: 100, outputTokens: 20 }, first);
  tracker.record({ requestId: "request-1", inputTokens: 110, outputTokens: 30 }, first);
  tracker.record({ requestId: "request-2", inputTokens: 50, outputTokens: 10 }, second);
  assert.deepEqual(tracker.totals(), {
    sessionInputTokens: 160,
    sessionOutputTokens: 40,
  });
  const snapshot = tracker.snapshot([{ role: "user", content: "current" }], null);
  assert.equal(snapshot.currentContextTokens, countProviderContext([{ role: "user", content: "current" }]));
  assert.equal(snapshot.contextLimitKnown, false);
  assert.equal(snapshot.usagePercent, null);
});

test("context limits come only from trusted configuration metadata", () => {
  assert.deepEqual(resolveContextLimit("big-cock", { model: "big-cock", providers: {} }), { limit: null, source: "unknown" });
  assert.deepEqual(resolveContextLimit("auto-free", { model: "auto-free", providers: {} }), { limit: null, source: "unknown" });
  let resolved = resolveContextLimit("custom/model", {
    providers: { custom: { baseURL: "https://example.com", contextLimit: 128_000 } },
  });
  assert.equal(resolved.limit, 128_000);
  assert.equal(resolved.source, "provider");
  resolved = resolveContextLimit("big-cock", {
    model: "big-cock",
    providers: {},
    contextLimit: 64_000,
  });
  assert.equal(resolved.limit, 64_000);
  assert.equal(resolved.source, "config");
  // Test config.models[modelName].contextLimit
  resolved = resolveContextLimit("big-cock", {
    model: "big-cock",
    providers: {},
    models: { "big-cock": { contextLimit: 128_000 } },
  });
  assert.equal(resolved.limit, 128_000);
  assert.equal(resolved.source, "config");
});

test("compaction lifecycle keeps stable usage until atomic recount", async () => {
  const messages = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `historical-${index} ${"x".repeat(900)}`,
  }));
  let requests = 0;
  const agent = new Agent(new Registry(), {
    workspace: mkdtempSync(join(tmpdir(), "khazai-context-lifecycle-")),
    sessionState: { messages, summary: "" },
    intentResolver: async () => ({
      intent: "answer",
      category: "ANSWER",
      operation: "answer",
      requiredEvidence: [],
      requiresPlan: false,
    }),
    chat: async (_context, options) => {
      requests++;
      options.onEvent?.({ type: "text-delta", text: "Done." });
      return "Done.";
    },
  });
  const initial = agent.contextUsage();
  agent._config.contextLimit = Math.ceil(initial.projectedRequestTokens / 0.8);
  agent._config.compactThreshold = 0.8;
  const events = [];
  for await (const event of agent.loop("Summarize the current state")) events.push(event);
  const lifecycle = events.filter(event => event.type === "compaction-state");
  assert.deepEqual(lifecycle.map(event => event.status), [
    "scheduled",
    "preparing",
    "summarizing",
    "committing",
    "recounting",
    "completed",
  ]);
  const stable = lifecycle.filter(event => event.status !== "completed")
    .map(event => event.usage?.currentContextTokens)
    .filter(Number.isFinite);
  assert.equal(new Set(stable).size, 1);
  assert.ok(lifecycle.at(-1).usage.currentContextTokens < stable[0]);
  assert.equal(requests, 1);
});

test("failed recovery compaction retains history and does not loop", async () => {
  const agent = new Agent(new Registry(), {
    workspace: mkdtempSync(join(tmpdir(), "khazai-context-failure-")),
    chatHandlesRetries: true,
    intentResolver: async () => ({
      intent: "answer",
      category: "ANSWER",
      operation: "answer",
      requiredEvidence: [],
      requiresPlan: false,
    }),
    chat: async () => {
      const error = new Error("maximum context length exceeded");
      error.status = 400;
      throw error;
    },
  });
  let requests = 0;
  const original = agent._chat;
  agent._chat = async (...args) => {
    requests++;
    return original(...args);
  };
  const events = [];
  for await (const event of agent.loop("Keep this request intact")) events.push(event);
  assert.equal(requests, 1);
  assert.deepEqual(
    events.filter(event => event.type === "compaction-state").map(event => event.status),
    ["scheduled", "preparing", "summarizing", "failed"],
  );
  assert.match(events.find(event => event.type === "error")?.content || "", /could not be completed/);
  assert.equal(agent._messages.some(message => message.content?.includes("Keep this request intact")), true);
});
