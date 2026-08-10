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

test("AIChat suppresses repeated truncated tool-call cards and ends after one recovery", async () => {
  const registry = new Registry();
  registry.register({
    name: "read",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    async execute() { return "source"; },
  });
  let requests = 0;
  const agent = new Agent(registry, {
    workspace: mkdtempSync(join(tmpdir(), "khazai-aichat-recovery-")),
    model: "aichat/claude-haiku-4-5",
    intentResolver: async ({ input }) => intent(input),
    chat: async () => {
      requests++;
      return '{"tool":"read","args":{"path":"package';
    },
  });
  const events = [];
  for await (const event of agent.loop("Read package.json")) events.push(event);

  assert.equal(requests, 2);
  assert.equal(events.some(event => event.tool === "invalid_tool_call"), false);
  assert.match(events.find(event => event.type === "error")?.content || "", /complete tool call/);
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
