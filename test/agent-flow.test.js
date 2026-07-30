import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../app/agent.js";
import { Registry } from "../app/registry.js";
import { bashTool } from "../tools/shell.js";

function intent(intent = "answer") {
  return async ({ input }) => ({
    intent,
    category: intent === "change" ? "MODIFICATION" : "ANSWER",
    operation: intent === "change" ? "modify_code" : "answer",
    requiredEvidence: intent === "change" ? ["mutation"] : [],
    requiresPlan: false,
    raw: input,
  });
}

function scripted(responses) {
  return async (_messages, options) => {
    const response = responses.shift();
    if (response === undefined) throw new Error("Unexpected extra model turn");
    for (let offset = 0; offset < response.length; offset += 11) {
      options.onToken?.(response.slice(offset, offset + 11));
    }
    return response;
  };
}

test("agent forwards stable session scope to provider requests", async () => {
  let request;
  const agent = new Agent(new Registry(), {
    workspace: mkdtempSync(join(tmpdir(), "khazai-provider-scope-")),
    sessionId: "session-contract",
    intentResolver: intent(),
    chat: async (_messages, options) => {
      request = options;
      return "done";
    },
  });
  for await (const _event of agent.loop("hello")) {}
  assert.equal(request.sessionId, "session-contract");
  assert.ok(request.runId);
  assert.ok(request.turnId);
});

test("identity questions use the provider while identity leakage is sanitized", async () => {
  let providerCalls = 0;
  const agent = new Agent(new Registry(), {
    workspace: mkdtempSync(join(tmpdir(), "khazai-identity-")),
    chat: async () => {
      providerCalls++;
      return "I'm MiMo, developed by Xiaomi.";
    },
  });
  const events = [];
  for await (const event of agent.loop("who are you?")) events.push(event);
  const visible = events.filter(event => event.type === "stream").map(event => event.token).join("");
  assert.equal(providerCalls, 1);
  assert.match(visible, /KhazAI/);
  assert.doesNotMatch(visible, /MiMo|Xiaomi/i);
});

test("normal model prose remains streamed", async () => {
  const response = "This response is intentionally long enough to prove that tokens are released before the provider finishes the complete answer. ".repeat(3);
  let providerFinished = false;
  let streamedBeforeFinish = false;
  const agent = new Agent(new Registry(), {
    workspace: mkdtempSync(join(tmpdir(), "khazai-stream-")),
    intentResolver: intent(),
    chat: async (_messages, options) => {
      for (let offset = 0; offset < response.length; offset += 20) {
        options.onToken?.(response.slice(offset, offset + 20));
        await new Promise(resolve => setImmediate(resolve));
      }
      providerFinished = true;
      return response;
    },
  });
  const visible = [];
  for await (const event of agent.loop("explain streaming")) {
    if (event.type === "stream") {
      visible.push(event.token);
      if (!providerFinished) streamedBeforeFinish = true;
    }
  }
  assert.equal(streamedBeforeFinish, true);
  assert.equal(visible.join(""), response);
});

test("empty provider responses are retried before surfacing an error", async () => {
  let calls = 0;
  const agent = new Agent(new Registry(), {
    workspace: mkdtempSync(join(tmpdir(), "khazai-empty-response-")),
    intentResolver: intent(),
    chat: async (_messages, options) => {
      calls++;
      if (calls === 1) return "";
      options.onToken?.("Recovered response.");
      return "Recovered response.";
    },
  });
  const events = [];
  for await (const event of agent.loop("answer this")) events.push(event);
  assert.equal(calls, 2);
  assert.equal(events.some(event => event.type === "error"), false);
  assert.match(events.filter(event => event.type === "stream").map(event => event.token).join(""), /Recovered response/);
});

test("provider timeout is configurable per workspace", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-provider-timeout-"));
  writeFileSync(join(workspace, ".khazai-ai.json"), JSON.stringify({ providerTimeout: 180_000 }));
  let timeoutMs;
  const agent = new Agent(new Registry(), {
    workspace,
    intentResolver: intent(),
    chat: async (_messages, options) => {
      timeoutMs = options.timeoutMs;
      options.onToken?.("Done.");
      return "Done.";
    },
  });

  for await (const _event of agent.loop("answer this")) {}
  assert.equal(timeoutMs, 180_000);
});

test("provider timeout terminates one scoped analysis without retrying", async () => {
  let calls = 0;
  const agent = new Agent(new Registry(), {
    workspace: mkdtempSync(join(tmpdir(), "khazai-provider-timeout-finalize-")),
    intentResolver: intent(),
    chat: async () => {
      calls++;
      throw new Error("Request timed out");
    },
  });
  const scope = { runId: "run-timeout", turnId: "turn-timeout" };
  const events = [];

  for await (const event of agent.loop("answer this", undefined, scope)) events.push(event);

  assert.equal(calls, 1);
  assert.equal(events.filter(event => event.type === "thinking").length, 1);
  assert.equal(events.filter(event => event.type === "error").length, 1);
  assert.deepEqual(
    events.filter(event => ["thinking", "error"].includes(event.type))
      .map(event => [event.runId, event.turnId]),
    [["run-timeout", "turn-timeout"], ["run-timeout", "turn-timeout"]],
  );
  assert.equal(events.at(-1).content, "Analysis timed out");
});

test("recoverable provider continuation retries without rerunning completed tools", async () => {
  let toolCalls = 0;
  let modelCalls = 0;
  const requestIds = [];
  const registry = new Registry();
  registry.register({
    name: "read",
    description: "Read a fixture.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    async execute() {
      toolCalls++;
      return "completed tool result";
    },
  });
  const agent = new Agent(registry, {
    workspace: mkdtempSync(join(tmpdir(), "khazai-provider-retry-continuation-")),
    intentResolver: intent(),
    chatHandlesRetries: true,
    chat: async (_messages, options) => {
      modelCalls++;
      requestIds.push(options.requestId);
      if (modelCalls === 1) {
        return JSON.stringify({ tool: "read", args: { path: "fixture.txt" }, id: "read-once" });
      }
      if (modelCalls === 2) {
        const error = new Error("HTTP 500: Internal Server Error");
        error.status = 500;
        error.attempts = 3;
        throw error;
      }
      return "Recovered final answer.";
    },
  });
  const failed = [];
  for await (const event of agent.loop("inspect and answer")) failed.push(event);
  assert.equal(toolCalls, 1);
  assert.equal(agent.hasRecoverableProviderRequest(), true);
  assert.equal(failed.at(-1).content, "[×] big-cock provider returned HTTP 500 after 3 attempts.");

  const recovered = [];
  for await (const event of agent.loop("", undefined, {
    runId: "retry-run",
    turnId: "retry-turn",
    retryProvider: true,
  })) recovered.push(event);
  assert.equal(toolCalls, 1);
  assert.equal(modelCalls, 3);
  assert.equal(new Set(requestIds).size, 3);
  assert.equal(agent.hasRecoverableProviderRequest(), false);
  assert.equal(agent._messages.filter(message => message.role === "user" && !String(message.content).startsWith("---TOOL")).length, 1);
  assert.match(recovered.filter(event => event.type === "stream").map(event => event.token).join(""), /Recovered final answer/);
});

test("default hot path sends one primary request and releases typed text immediately", async () => {
  let calls = 0;
  let providerFinished = false;
  let firstVisibleBeforeFinish = false;
  const agent = new Agent(new Registry(), {
    workspace: mkdtempSync(join(tmpdir(), "khazai-direct-hot-path-")),
    chat: async (_messages, options) => {
      calls++;
      options.onEvent?.({ type: "text-delta", text: "Immediate " });
      await new Promise(resolve => setImmediate(resolve));
      options.onEvent?.({ type: "text-delta", text: "response." });
      options.onEvent?.({ type: "finish", reason: "stop" });
      providerFinished = true;
      return "Immediate response.";
    },
  });
  const visible = [];
  for await (const event of agent.loop("explain the current module")) {
    if (event.type === "stream") {
      visible.push(event.token);
      if (!providerFinished) firstVisibleBeforeFinish = true;
    }
  }
  assert.equal(calls, 1);
  assert.equal(firstVisibleBeforeFinish, true);
  assert.equal(visible.join(""), "Immediate response.");
  assert.ok(agent._latency.requestDispatched >= agent._latency.inputReceived);
  assert.ok(agent._latency.uiFirstText >= agent._latency.providerFirstDelta);
});

test("system prompt relies on native tools without duplicating their schemas", () => {
  const registry = new Registry();
  registry.register({
    name: "read",
    description: "Read one file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    async execute() { return "source"; },
  });
  const agent = new Agent(registry, {
    workspace: mkdtempSync(join(tmpdir(), "khazai-native-schema-")),
  });
  const system = agent._buildSystem();
  assert.doesNotMatch(system, /Available tools:/);
  assert.doesNotMatch(system, /respond with EXACTLY one JSON object/i);
  assert.doesNotMatch(system, /"required":\s*\[\s*"path"/);
});

test("Big Pickle prompt keeps KhazAI branding and composes exact environment metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "khazai-prompt-git-"));
  mkdirSync(join(root, ".git"));
  const workspace = join(root, "packages", "cli");
  mkdirSync(workspace, { recursive: true });
  const agent = new Agent(new Registry(), { workspace, model: "big-cock" });
  const system = agent._buildSystem();

  assert.match(system, /You are KhazAI, an interactive CLI agent/);
  assert.match(system, /powered by the model opencode\/big-pickle/);
  assert.match(system, new RegExp(`Working directory: ${workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(system, new RegExp(`Worktree: ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(system, /Is directory a git repo: yes/);
  assert.match(system, /Follow the project's existing conventions/);
  assert.match(system, /Never expose, print, commit, or embed secrets/);
  assert.match(system, /Make independent read-only tool calls in parallel/);
  assert.doesNotMatch(system, /\bOpenCode\b|opencode\.ai\/docs|TodoWrite/);
});

test("system prompt reports non-Git workspaces accurately", () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-prompt-plain-"));
  const system = new Agent(new Registry(), { workspace })._buildSystem();
  assert.match(system, /Is directory a git repo: no/);
  assert.match(system, new RegExp(`Worktree: ${workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("system prompt includes only permitted skill summaries and invalidates its cache", () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-prompt-skills-"));
  const skillDirectory = join(workspace, ".khazai", "skills", "prompt-helper");
  mkdirSync(skillDirectory, { recursive: true });
  const skillPath = join(skillDirectory, "SKILL.md");
  writeFileSync(skillPath, "---\nname: prompt-helper\ndescription: First skill description.\n---\nInstructions\n");

  const registry = new Registry();
  registry.register({
    name: "skill",
    description: "Load a skill.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    async execute() { return "instructions"; },
  });
  const agent = new Agent(registry, { workspace });
  const first = agent._buildSystem();
  assert.match(first, /AVAILABLE SKILLS:/);
  assert.match(first, /prompt-helper: First skill description/);

  writeFileSync(skillPath, "---\nname: prompt-helper\ndescription: Updated and longer skill description.\n---\nInstructions\n");
  const second = agent._buildSystem();
  assert.notEqual(second, first);
  assert.match(second, /prompt-helper: Updated and longer skill description/);

  mkdirSync(join(workspace, ".khazai"), { recursive: true });
  writeFileSync(join(workspace, ".khazai", "permissions.json"), JSON.stringify({
    skill: { "prompt-helper": "deny" },
  }));
  const deniedAgent = new Agent(registry, { workspace });
  assert.doesNotMatch(deniedAgent._buildSystem(), /prompt-helper:/);
  assert.doesNotMatch(new Agent(new Registry(), { workspace })._buildSystem(), /AVAILABLE SKILLS:/);
});

test("incomplete streamed Markdown is not semantically retried", async () => {
  const contexts = [];
  const agent = new Agent(new Registry(), {
    model: "claude",
    workspace: mkdtempSync(join(tmpdir(), "khazai-continuation-")),
    intentResolver: intent(),
    chat: async (messages, options) => {
      contexts.push(messages.map(message => message.content).join("\n"));
      const response = contexts.length === 1
        ? "Available features:\n\n- **Search"
        : " tools**\n- Shell commands";
      options.onToken?.(response);
      return response;
    },
  });
  const events = [];
  for await (const event of agent.loop("list features")) events.push(event);
  const visible = events.filter(event => event.type === "stream").map(event => event.token).join("");
  assert.equal(contexts.length, 1);
  assert.equal(visible, "Available features:\n\n- **Search");
  assert.equal(events.filter(event => event.type === "stream-end").length, 1);
});

test("tool calls emit pending, running, completed, and finish lifecycle states", async () => {
  const registry = new Registry();
  registry.register({
    name: "write",
    description: "write",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    async execute() { return "Written file"; },
  });
  const agent = new Agent(registry, {
    workspace: mkdtempSync(join(tmpdir(), "khazai-lifecycle-flow-")),
    intentResolver: intent("change"),
    chat: scripted([
      JSON.stringify({ tool: "write", args: { path: "a.js", content: "export default 1;" }, id: "call-a" }),
      "Implemented.",
    ]),
  });
  const events = [];
  for await (const event of agent.loop("create a.js")) events.push(event);
  const states = events
    .filter(event => event.type === "tool-part" && event.part?.tool === "write")
    .map(event => event.part.state.status);
  assert.deepEqual(states, ["pending", "running", "completed"]);
  assert.equal(events.some(event => event.type === "tool-part" && event.part?.type === "step-finish"), true);
  assert.equal(events.some(event => event.type === "steering"), false);
});

test("streamed prose is committed before a tool call", async () => {
  const registry = new Registry();
  registry.register({
    name: "write",
    description: "write",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    async execute() { return "Written 10 bytes to game.py"; },
  });
  let calls = 0;
  const agent = new Agent(registry, {
    workspace: mkdtempSync(join(tmpdir(), "khazai-stream-tool-")),
    intentResolver: intent("change"),
    chat: async (_messages, options) => {
      calls++;
      if (calls === 1) {
        options.onEvent?.({ type: "text-delta", text: "I will create the game now." });
        return 'I will create the game now.\n{"tool":"write","args":{"path":"game.py","content":"print(123)"},"id":"write-game"}';
      }
      options.onEvent?.({ type: "text-delta", text: "Created and validated game.py." });
      return "Created and validated game.py.";
    },
  });

  const events = [];
  for await (const event of agent.loop("create game.py")) events.push(event);
  const commitIndex = events.findIndex(event => event.type === "stream-commit");
  const toolIndex = events.findIndex(event =>
    event.type === "tool-part" && event.part?.tool === "write"
  );
  assert.ok(commitIndex >= 0);
  assert.ok(commitIndex < toolIndex);
  assert.equal(events.filter(event => event.type === "stream").map(event => event.token).join(""), "I will create the game now.Created and validated game.py.");
  assert.equal(events.filter(event => event.type === "stream-end").length, 1);
});

test("an edit request after inspection is sent directly without evidence steering", async () => {
  const registry = new Registry();
  registry.register({
    name: "read",
    description: "read",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    async execute() { return "File: snake.py\nLines: 2\n1: old\n2: code"; },
  });
  registry.register({
    name: "edit",
    description: "edit",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldString: { type: "string" },
        newString: { type: "string" },
      },
      required: ["path", "oldString", "newString"],
    },
    async execute() { return "Edited snake.py"; },
  });

  const folderAnswer = "Folder ini berisi snake.py, sebuah game Snake CLI.";
  const responses = [
    '{"tool":"read","args":{"path":"snake.py"},"id":"inspect-snake"}',
    folderAnswer,
    folderAnswer,
    '{"tool":"edit","args":{"path":"snake.py","oldString":"old","newString":"new"},"id":"edit-snake"}',
    "Updated snake.py.",
  ];
  const contexts = [];
  const agent = new Agent(registry, {
    workspace: mkdtempSync(join(tmpdir(), "khazai-inspect-edit-")),
    intentResolver: async ({ input }) => input.includes("edit")
      ? {
          intent: "change",
          category: "MODIFICATION",
          operation: "modify",
          requiredEvidence: ["mutation"],
          modifiesFiles: true,
        }
      : {
          intent: "inspect",
          category: "INSPECTION",
          operation: "inspect_code",
          requiredEvidence: ["inspection"],
        },
    chat: async (messages, options) => {
      contexts.push(messages);
      const response = responses.shift();
      if (response === undefined) throw new Error("Unexpected extra model turn");
      if (response === folderAnswer || response === "Updated snake.py.") {
        options.onEvent?.({ type: "text-delta", text: response });
      } else {
        options.onToken?.(response);
      }
      return response;
    },
  });

  for await (const _event of agent.loop("check the files in this folder")) {}
  const secondTurn = [];
  for await (const event of agent.loop("edit the code in snake.py")) secondTurn.push(event);

  const staleStreamIndex = secondTurn.findIndex(event =>
    event.type === "stream" && event.token.includes("Folder ini berisi")
  );
  const editIndex = secondTurn.findIndex(event =>
    event.type === "tool-part" && event.part?.tool === "edit"
  );
  assert.ok(staleStreamIndex >= 0, "the fixture must reproduce the stale provider answer");
  assert.equal(editIndex, -1, "runtime must not force an edit after model completion");
  assert.match(
    contexts[2].findLast(message => message.role === "user")?.content || "",
    /edit the code in snake\.py/i,
  );
  assert.doesNotMatch(JSON.stringify(contexts[2]), /INTERNAL STEERING|mutation evidence/i);
});
