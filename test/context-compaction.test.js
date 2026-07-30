import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../app/agent.js";
import { Registry } from "../app/registry.js";

function agentWithState(state) {
  return new Agent(new Registry(), {
    workspace: mkdtempSync(join(tmpdir(), "khazai-compact-")),
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
  const agent = agentWithState({ messages, summary: "" });
  const usage = agent.contextUsage();
  agent._config.contextLimit = usage.projectedRequestTokens;
  agent._config.compactThreshold = 1;
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
