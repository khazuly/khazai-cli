import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../app/agent.js";
import { Registry } from "../app/registry.js";

function intent(input) {
  return {
    intent: "answer",
    category: "ANSWER",
    operation: "answer",
    requiredEvidence: [],
    requiresPlan: false,
    raw: input,
  };
}

function incompleteWrite(options) {
  options.onEvent?.({ type: "tool-call-delta", delta: [
    { index: 2, id: "call-write", function: { name: "Wr", arguments: "" } },
  ] });
  options.onEvent?.({ type: "tool-call-delta", delta: [
    { index: 2, id: "call-write", function: { name: "ite", arguments: '{"path":"pycompiler.py","content":"partial-code' } },
  ] });
  options.onEvent?.({ type: "finish", reason: "stop" });
  return "";
}

test("AIChat automatically recovers an incomplete Write without duplicate state", async () => {
  const registry = new Registry();
  let writes = 0;
  registry.register({
    name: "write",
    description: "Write a file",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    async execute() { writes++; return "Written 20 bytes to pycompiler.py"; },
  });
  let requests = 0;
  const contexts = [];
  const agent = new Agent(registry, {
    workspace: mkdtempSync(join(tmpdir(), "khazai-aichat-recovery-")),
    model: "aichat/claude-haiku-4-5",
    config: { maxTurns: 4 },
    intentResolver: async ({ input }) => intent(input),
    chat: async (messages, options) => {
      requests++;
      contexts.push(messages);
      if (requests === 1) return incompleteWrite(options);
      if (requests === 2) return '{"tool":"write","args":{"path":"pycompiler.py","content":"final-code"}}';
      return "Created pycompiler.py.";
    },
  });
  const events = [];
  for await (const event of agent.loop("Create pycompiler.py")) events.push(event);

  assert.equal(requests, 3);
  assert.equal(writes, 1);
  assert.equal(events.some(event => event.tool === "invalid_tool_call"), false);
  assert.equal(events.filter(event => event.type === "tool-call" && event.tool === "write").length, 1);
  assert.equal(events.filter(event => event.type === "tool-result" && event.tool === "write").length, 1);
  assert.equal(agent._messages.filter(message => message.role === "user" && message.content === "Create pycompiler.py").length, 1);
  assert.equal(agent._messages.some(message => String(message.content || "").includes("partial-code")), false);
  assert.equal(contexts[1].filter(message => message.role === "user" && message.content === "Create pycompiler.py").length, 1);
  assert.match(contexts[1].at(-1).content, /latest tool result already answers/);
  assert.equal(events.some(event => event.type === "provider-diagnostic" && event.diagnostic?.recoveryResult === "succeeded"), true);
});

test("AIChat recovers after two incomplete tool calls", async () => {
  const registry = new Registry();
  let writes = 0;
  registry.register({
    name: "write",
    description: "Write a file",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    async execute() { writes++; return "Written 20 bytes to pycompiler.py"; },
  });
  let requests = 0;
  const agent = new Agent(registry, {
    workspace: mkdtempSync(join(tmpdir(), "khazai-aichat-recovery-fail-")),
    model: "aichat/claude-haiku-4-5",
    intentResolver: async ({ input }) => intent(input),
    chat: async (_messages, options) => {
      requests++;
      if (requests < 3) return incompleteWrite(options);
      if (requests === 3) return '{"tool":"write","args":{"path":"pycompiler.py","content":"final-code"}}';
      return "Created pycompiler.py.";
    },
  });
  const events = [];
  for await (const event of agent.loop("Create pycompiler.py")) events.push(event);

  assert.equal(requests, 4);
  assert.equal(writes, 1);
  assert.equal(events.some(event => event.type === "error"), false);
  assert.equal(events.filter(event => event.type === "tool-call" && event.tool === "write").length, 1);
});

test("AIChat accepts a final answer after a partial tool call", async () => {
  let requests = 0;
  const agent = new Agent(new Registry(), {
    workspace: mkdtempSync(join(tmpdir(), "khazai-aichat-recovery-answer-")),
    model: "aichat/claude-haiku-4-5",
    intentResolver: async ({ input }) => intent(input),
    chat: async (_messages, options) => {
      requests++;
      return requests === 1 ? incompleteWrite(options) : "The previous command completed successfully.";
    },
  });
  const events = [];
  for await (const event of agent.loop("Run the command")) events.push(event);

  assert.equal(events.some(event => event.type === "error"), false);
  assert.match(events.filter(event => event.type === "stream").map(event => event.token).join(""), /completed successfully/);
});

test("AIChat fails once after its incomplete tool recovery budget is exhausted", async () => {
  const registry = new Registry();
  registry.register({
    name: "write",
    description: "Write a file",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    async execute() { throw new Error("must not execute"); },
  });
  let requests = 0;
  const agent = new Agent(registry, {
    workspace: mkdtempSync(join(tmpdir(), "khazai-aichat-recovery-fail-")),
    model: "aichat/claude-haiku-4-5",
    intentResolver: async ({ input }) => intent(input),
    chat: async (_messages, options) => { requests++; return incompleteWrite(options); },
  });
  const events = [];
  for await (const event of agent.loop("Create pycompiler.py")) events.push(event);

  assert.equal(requests, 3);
  assert.equal(events.filter(event => event.type === "error").length, 1);
  assert.equal(events.find(event => event.type === "error")?.content, "AIChat could not complete the tool call.");
  assert.equal(events.some(event => event.type === "tool-call"), false);
});

test("other providers retain their existing invalid tool-call handling", async () => {
  const registry = new Registry();
  registry.register({
    name: "write",
    description: "Write a file",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    async execute() { throw new Error("must not execute"); },
  });
  const agent = new Agent(registry, {
    workspace: mkdtempSync(join(tmpdir(), "khazai-other-provider-")), model: "big-cock", config: { maxTurns: 1 },
    intentResolver: async ({ input }) => intent(input), chat: async () => '{"tool":"write","args":{"path":"x.py"',
  });
  const events = [];
  for await (const event of agent.loop("Create x.py")) events.push(event);

  assert.equal(events.some(event => event.tool === "invalid_tool_call"), true);
});

test("AIChat retries an early URL clarification with a tool call", async () => {
  const registry = new Registry();
  registry.register({
    name: "webfetch",
    description: "Fetch a public URL",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async execute() { return "public landing page"; },
  });
  let requests = 0;
  const agent = new Agent(registry, {
    workspace: mkdtempSync(join(tmpdir(), "khazai-aichat-steering-")),
    model: "aichat/claude-haiku-4-5",
    config: { maxTurns: 4 },
    intentResolver: async ({ input }) => intent(input),
    chat: async () => {
      requests++;
      if (requests === 1) return "Could you clarify what you want to inspect?";
      if (requests === 2) return '{"tool":"webfetch","args":{"url":"https://example.test"}}';
      return "The public page was retrieved.";
    },
  });
  const events = [];
  for await (const event of agent.loop("Inspect https://example.test")) events.push(event);

  assert.equal(requests, 3);
  assert.equal(events.some(event => event.type === "tool-call" && event.tool === "webfetch"), true);
  assert.equal(events.some(event => /clarify/i.test(event.content || "")), false);
});
