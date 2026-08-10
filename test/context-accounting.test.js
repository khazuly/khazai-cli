import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../app/agent.js";
import { Registry } from "../app/registry.js";
import { ContextUsageTracker, resolveContextLimit } from "../app/context-usage.js";

const SYSTEM_BASELINE_MIN = 400;
const SYSTEM_BASELINE_MAX = 1500;

function agentOpts(overrides = {}) {
  return {
    workspace: mkdtempSync(join(tmpdir(), "khazai-context-")),
    config: { modelSettings: {}, models: {}, contextLimit: null },
    intentResolver: async () => ({
      intent: "answer",
      category: "ANSWER",
      operation: "answer",
      requiredEvidence: [],
      requiresPlan: false,
    }),
    chat: async (_context, options) => {
      options.onEvent?.({ type: "text-delta", text: "Response." });
      return "Response.";
    },
    ...overrides,
  };
}

test("1. new session starts with baseline context", async () => {
  const agent = new Agent(new Registry(), agentOpts());
  const usage = agent.contextUsage();
  assert.ok(
    usage.currentContextTokens >= SYSTEM_BASELINE_MIN
    && usage.currentContextTokens <= SYSTEM_BASELINE_MAX,
    `Baseline ${usage.currentContextTokens} should be between ${SYSTEM_BASELINE_MIN}-${SYSTEM_BASELINE_MAX}`,
  );
  assert.equal(usage.contextLimitKnown, false);
  assert.equal(usage.contextLimit, null);
  assert.equal(usage.contextLimitSource, "unknown");
});

test("2. task one grows context from baseline", async () => {
  const agent = new Agent(new Registry(), agentOpts());
  const baseline = agent.contextUsage().currentContextTokens;


  agent._messages.push({ role: "user", content: "Task 1: inspect the workspace" });
  agent._messages.push({
    role: "assistant",
    content: "I found several relevant files.",
    tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{}" } }],
  });
  agent._messages.push({ role: "tool", tool_call_id: "call-1", name: "read", content: "file content here " .repeat(200) });
  agent._messages.push({ role: "assistant", content: "Here is what I found." });

  const afterTask1 = agent.contextUsage();
  assert.ok(
    afterTask1.currentContextTokens > baseline + 200,
    `Context after task 1 (${afterTask1.currentContextTokens}) should be > baseline (${baseline}) + 200`,
  );
});

test("3. task two increases existing context instead of resetting", async () => {
  const agent = new Agent(new Registry(), agentOpts());
  const baseline = agent.contextUsage().currentContextTokens;


  agent._messages.push({ role: "user", content: "Task 1: find the bug " + "x".repeat(500) });
  agent._messages.push({ role: "assistant", content: "Found it in main.js " + "y".repeat(300) });
  const afterTask1 = agent.contextUsage();
  assert.ok(
    afterTask1.currentContextTokens > baseline + 150,
    `Context after task 1 (${afterTask1.currentContextTokens}) should be > baseline (${baseline}) + 150`,
  );


  agent._messages.push({ role: "user", content: "Task 2: fix the bug " + "z".repeat(200) });
  agent._messages.push({ role: "assistant", content: "Fixed it. " + "w".repeat(150) });
  const afterTask2 = agent.contextUsage();


  assert.ok(
    afterTask2.currentContextTokens > afterTask1.currentContextTokens,
    `Context after task 2 (${afterTask2.currentContextTokens}) should be > after task 1 (${afterTask1.currentContextTokens})`,
  );

  assert.ok(
    afterTask2.currentContextTokens > baseline + 300,
    `Context after task 2 (${afterTask2.currentContextTokens}) should include historical messages (baseline ${baseline})`,
  );
});

test("4. turn usage resets without resetting current context", async () => {
  const agent = new Agent(new Registry(), agentOpts());


  agent._usageTracker.record({ requestId: "req-1", inputTokens: 200, outputTokens: 50 }, { runId: "run-1", turnId: "turn-1" });
  const turn1Usage = agent.contextUsage();
  assert.equal(turn1Usage.currentTurnInputTokens, 200);
  assert.equal(turn1Usage.currentTurnOutputTokens, 50);


  agent._usageTracker.resetTurn();


  agent._messages.push({ role: "user", content: "Second request" });
  agent._usageTracker.record({ requestId: "req-2", inputTokens: 100, outputTokens: 20 }, { runId: "run-2", turnId: "turn-2" });
  const turn2Usage = agent.contextUsage();


  assert.equal(turn2Usage.currentTurnInputTokens, 100, "Turn input reset");
  assert.equal(turn2Usage.currentTurnOutputTokens, 20, "Turn output reset");

  assert.ok(turn2Usage.sessionInputTokens >= 300, "Session totals cumulative");

  assert.ok(
    turn2Usage.currentContextTokens >= turn1Usage.currentContextTokens,
    "Current context should not reset with turn",
  );
});

test("5. saving and resuming preserves context", async () => {
  const agent = new Agent(new Registry(), agentOpts());


  agent._messages.push({ role: "user", content: "Task 1: original task" });
  agent._messages.push({ role: "assistant", content: "Completed task 1 with detailed analysis." });
  const before = agent.contextUsage().currentContextTokens;


  const state = agent.exportSessionState();


  const resumed = new Agent(new Registry(), agentOpts({ sessionState: state }));
  const after = resumed.contextUsage().currentContextTokens;


  assert.ok(
    Math.abs(after - before) / Math.max(before, 1) < 0.5,
    `Resumed context (${after}) should approximate saved context (${before})`,
  );
  assert.ok(
    after > SYSTEM_BASELINE_MIN,
    `Resumed context (${after}) should be above baseline`,
  );
});

test("6. real compaction reduces context", async () => {
  const agent = new Agent(new Registry(), agentOpts());
  agent._config.contextLimit = 4000;
  agent._config.tokenBudget = 1000;

  for (let i = 0; i < 8; i++) {
    agent._appendMessage({ role: "user", content: `Message ${i} ${"x".repeat(500)}` });
    agent._appendMessage({ role: "assistant", content: `Response ${i} ${"y".repeat(500)}` });
  }
  agent._appendMessage({ role: "user", content: "Continue the current task without repeating completed work." });
  const before = agent.contextUsage().currentContextTokens;
  assert.ok(before > 2000, `Context before compaction (${before}) should be substantial`);

  const compacted = agent._compactMessages(true);
  assert.ok(compacted, "Compaction should succeed");

  const after = agent.contextUsage().currentContextTokens;
  assert.ok(
    after < before,
    `Context after compaction (${after}) should be less than before (${before})`,
  );
  assert.ok(
    agent._summary.includes("Message"),
    "Summary should preserve user intent from compacted history",
  );
});

test("7. unknown limits never produce fake percentages", () => {
  const tracker = new ContextUsageTracker();
  const snapshot = tracker.snapshot(
    [{ role: "user", content: "test" }],
    null,
  );
  assert.equal(snapshot.contextLimit, null);
  assert.equal(snapshot.contextLimitKnown, false);
  assert.equal(snapshot.usagePercent, null);
  assert.equal(snapshot.usageRatio, null);
  assert.ok(snapshot.currentContextTokens > 0, "Context tokens still reported");
});

test("8. configured limits produce correct context display values", () => {
  const tracker = new ContextUsageTracker();
  const snapshot = tracker.snapshot(
    [{ role: "user", content: "test" }],
    128000,
  );
  assert.equal(snapshot.contextLimit, 128000);
  assert.equal(snapshot.contextLimitKnown, true);
  assert.ok(snapshot.usagePercent !== null);
  assert.ok(snapshot.usagePercent < 1, "Usage percent tiny for single message");
  assert.ok(snapshot.usageRatio !== null);
  assert.ok(snapshot.usageRatio < 0.01);
});

test("9. config.models contextLimit is resolved", () => {
  const config = {
    model: "big-cock",
    providers: {},
    models: { "big-cock": { contextLimit: 128000 } },
    contextLimit: null,
  };
  const resolved = resolveContextLimit("big-cock", config);
  assert.equal(resolved.limit, 128000);
  assert.equal(resolved.source, "config");
});

test("10. stale recount callbacks cannot overwrite newer history", async () => {
  const agent = new Agent(new Registry(), agentOpts());


  const rev1 = agent._historyRevision;


  agent._messages.push({ role: "user", content: "First task " + "a".repeat(800) });
  agent._messages.push({ role: "assistant", content: "First response " + "b".repeat(800) });
  agent._messages.push({ role: "user", content: "Second task " + "c".repeat(800) });
  agent._messages.push({ role: "assistant", content: "Second response " + "d".repeat(800) });
  agent._messages.push({ role: "user", content: "Third task " + "e".repeat(800) });
  agent._messages.push({ role: "assistant", content: "Third response " + "f".repeat(800) });


  const rev2 = agent._historyRevision;
  assert.equal(rev1, rev2, "Revision unchanged by message append alone");


  agent._config.tokenBudget = 3000;
  const originalLen = agent._messages.length;
  const compacted = agent._compactMessages(true);
  assert.ok(compacted, "Compaction should succeed");
  const rev3 = agent._historyRevision;
  assert.ok(rev3 > rev2, "Compaction bumps revision");
  assert.ok(
    agent._tailStartIndex > 0 && agent._summary !== "",
    "Compaction should record tail start and summary",
  );
});

test("11. compactThreshold uses ratio comparison (not percentage)", async () => {
  const agent = new Agent(new Registry(), agentOpts({
    config: { modelSettings: {}, models: {}, contextLimit: 10000, compactThreshold: 0.5 },
  }));

  const usage = agent.contextUsage();
  assert.equal(usage.contextLimitKnown, true);


  const projectedRatio = usage.projectedRequestTokens / usage.contextLimit;
  assert.ok(projectedRatio < 0.5, "Fixture must stay below the configured ratio threshold");
  assert.equal(agent.compactIfNeeded(), false, "Should not compact when ratio < threshold");
});
