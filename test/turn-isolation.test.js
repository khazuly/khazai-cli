import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../app/agent.js";
import { Registry } from "../app/registry.js";

function workspace(name) {
  return mkdtempSync(join(tmpdir(), `khazai-${name}-`));
}

async function collect(agent, input, scope) {
  const events = [];
  for await (const event of agent.loop(input, undefined, scope)) events.push(event);
  return events;
}

test("a stale intent resolution cannot replace the latest task", async () => {
  let releaseOld;
  const oldResolution = new Promise(resolve => { releaseOld = resolve; });
  const agent = new Agent(new Registry(), {
    workspace: workspace("intent-epoch"),
    intentResolver: {
      resolve: ({ input }) => input.includes("trust-prompt")
        ? oldResolution
        : { intent: "answer", category: "QUESTION", operation: "answer" },
    },
    chat: async () => "Think activity is current.",
  });

  const old = collect(agent, "Improve trust-prompt.js");
  await new Promise(resolve => setImmediate(resolve));
  const current = collect(agent, "Improve Think activity");
  await new Promise(resolve => setImmediate(resolve));
  releaseOld({ intent: "change", category: "MODIFICATION", operation: "modify" });
  const [oldEvents, currentEvents] = await Promise.all([old, current]);

  assert.equal(oldEvents.some(event => event.type === "tool-call"), false);
  assert.equal(currentEvents.some(event => event.type === "stream-end"), true);
  assert.equal(agent._activeTask.goal, "Improve Think activity");
  assert.equal(agent._activeScope.objective, "Improve Think activity");
  assert.equal(agent._activeRun.taskEpoch, 2);
});

test("late provider completion cannot publish into a newer turn", async () => {
  let releaseOld;
  let providerStarted;
  const started = new Promise(resolve => { providerStarted = resolve; });
  let calls = 0;
  const agent = new Agent(new Registry(), {
    workspace: workspace("provider-epoch"),
    chat: async (_messages, options) => {
      calls++;
      if (calls > 1) return "Current response.";
      providerStarted();
      return new Promise(resolve => {
        releaseOld = () => {
          options.onToken?.("Stale response.");
          resolve("Stale response.");
        };
      });
    },
  });

  const old = collect(agent, "Old task");
  await started;
  const current = await collect(agent, "Current task");
  releaseOld();
  const oldEvents = await Promise.race([
    old,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Stale run did not settle.")), 1_000)),
  ]);

  assert.equal(oldEvents.some(event => event.type === "stream"), false);
  assert.match(current.filter(event => event.type === "stream").map(event => event.token).join(""), /Current response/);
  assert.equal(agent._activeScope.objective, "Current task");
});

test("a new task prevents queued tools from the previous epoch from starting", async () => {
  let releaseRead;
  let readStarted;
  const started = new Promise(resolve => { readStarted = resolve; });
  let edits = 0;
  let providerCalls = 0;
  const registry = new Registry();
  registry.register({
    name: "read",
    description: "Read one file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    execute: async () => {
      readStarted();
      return new Promise(resolve => { releaseRead = resolve; });
    },
  });
  registry.register({
    name: "edit",
    description: "Edit one file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    execute: async () => {
      edits++;
      return "updated";
    },
  });
  const agent = new Agent(registry, {
    workspace: workspace("queued-tools"),
    autoApprove: true,
    chat: async () => {
      providerCalls++;
      return providerCalls === 1
        ? JSON.stringify([
            { tool: "read", args: { path: "trust-prompt.js" }, id: "old-read" },
            { tool: "edit", args: { path: "trust-prompt.js" }, id: "old-edit" },
          ])
        : "The Think task is active.";
    },
  });

  const old = collect(agent, "Improve trust prompt");
  await started;
  const current = await collect(agent, "Improve Think activity");
  releaseRead("old source");
  const oldEvents = await old;

  assert.equal(edits, 0);
  assert.equal(oldEvents.some(event => event.callId === "old-edit"), false);
  assert.equal(current.some(event => event.type === "stream-end"), true);
  assert.equal(agent._lifecycle.parts.some(part => (
    part.callId === "old-read" && ["pending", "running"].includes(part.state?.status)
  )), false);
});

test("cancellation clears pending lifecycle state and suppresses late results", async () => {
  let releaseRead;
  let readStarted;
  const started = new Promise(resolve => { readStarted = resolve; });
  const registry = new Registry();
  registry.register({
    name: "read",
    description: "Read one file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    execute: async () => {
      readStarted();
      return new Promise(resolve => { releaseRead = resolve; });
    },
  });
  let providerCalls = 0;
  const agent = new Agent(registry, {
    workspace: workspace("cancelled-tools"),
    autoApprove: true,
    chat: async () => {
      providerCalls++;
      return providerCalls === 1
        ? JSON.stringify({ tool: "read", args: { path: "old.js" }, id: "cancelled-read" })
        : "Unexpected continuation.";
    },
  });

  const running = collect(agent, "Inspect old.js");
  await started;
  agent.abort();
  releaseRead("late result");
  const events = await running;

  assert.equal(events.some(event => event.type === "tool-result"), false);
  assert.equal(agent._lifecycle.parts.some(part => (
    part.callId === "cancelled-read" && ["pending", "running"].includes(part.state?.status)
  )), false);
  assert.equal(providerCalls, 1);
});

test("every tool continuation retains the current objective and exact result", async () => {
  const contexts = [];
  let calls = 0;
  const registry = new Registry();
  registry.register({
    name: "read",
    description: "Read a file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    execute: async () => "exact Think implementation",
  });
  const agent = new Agent(registry, {
    workspace: workspace("provider-context"),
    autoApprove: true,
    chat: async messages => {
      contexts.push(messages);
      calls++;
      if (calls === 1) return "Trust prompt task completed.";
      if (calls === 2) {
        return JSON.stringify({
          tool: "read",
          args: { path: "ui/analysis-activity.js" },
          id: "think-read",
        });
      }
      return "Think activity task completed.";
    },
  });

  await collect(agent, "Trust prompt overview");
  await collect(agent, "Think activity overview");

  for (const context of contexts.slice(1)) {
    const active = context.find(message => (
      message.role === "system"
      && String(message.content).startsWith("ACTIVE TASK FOR THIS TURN:")
    ));
    assert.match(active.content, /Think activity overview/);
    assert.doesNotMatch(active.content, /Trust prompt overview/);
  }
  assert.equal(contexts[2].some(message => (
    message.role === "tool"
    && message.tool_call_id === "think-read"
    && message.content === "exact Think implementation"
  )), true);
});

test("restored sessions discard transient tools and require explicit continuation", async () => {
  let providerContext;
  const agent = new Agent(new Registry(), {
    workspace: workspace("resume"),
    sessionState: {
      messages: [
        { role: "user", content: "Improve trust prompt" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "stale-edit",
            type: "function",
            function: { name: "edit", arguments: '{"path":"trust-prompt.js"}' },
          }],
        },
      ],
      parts: [{
        id: "stale-part",
        type: "tool",
        callId: "stale-edit",
        tool: "edit",
        state: { status: "pending", input: { path: "trust-prompt.js" } },
      }],
      recoverableProviderRequest: {
        model: "big-cock",
        currentRequest: "Improve trust prompt",
      },
    },
    chat: async messages => {
      providerContext = messages;
      return "Continued from history.";
    },
  });

  assert.equal(agent._currentRequest, "");
  assert.equal(agent._lifecycle.parts.length, 0);
  assert.equal(agent._messages.some(message => message.tool_calls?.length), false);
  await collect(agent, "continue the previous task");
  const active = providerContext.find(message => (
    message.role === "system"
    && String(message.content).startsWith("ACTIVE TASK FOR THIS TURN:")
  ));
  assert.match(active.content, /continue the previous task/);
  assert.equal(agent._activeScope.objective, "continue the previous task");
});
