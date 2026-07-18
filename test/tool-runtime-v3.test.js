import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../app/agent.js";
import { PermissionService } from "../app/permission.js";
import { Registry } from "../app/registry.js";
import { SessionStore, migrateSessionV3, migrateSessionV4 } from "../app/session-store.js";
import { ToolExecutor } from "../app/tool-executor.js";
import { ToolLifecycle } from "../app/tool-lifecycle.js";
import { todoWriteTool } from "../tools/todo.js";

test("dynamic registry loads OpenCode-compatible TypeScript tools with KhazAI precedence", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-custom-tools-"));
  for (const root of [".opencode", ".khazai"]) {
    mkdirSync(join(workspace, root, "tools"), { recursive: true });
  }
  writeFileSync(join(workspace, ".opencode", "tools", "math.ts"), [
    'import { tool } from "@opencode-ai/plugin"',
    "export default tool({",
    '  description: "OpenCode math",',
    "  args: { value: tool.schema.number() },",
    '  execute: async ({ value }) => `opencode:${value}`',
    "})",
  ].join("\n"));
  writeFileSync(join(workspace, ".khazai", "tools", "math.ts"), [
    'import { tool } from "@opencode-ai/plugin"',
    "export default tool({",
    '  description: "KhazAI math",',
    "  args: { value: tool.schema.number() },",
    '  execute: async ({ value }, context) => `${context.directory}:${value * 2}`',
    "})",
  ].join("\n"));

  const registry = await new Registry().load(workspace);
  const tool = registry.get("math");
  assert.equal(tool.description, "KhazAI math");
  assert.equal(tool.parameters.type, "object");
  assert.match(await tool.execute({ value: 4 }, { directory: workspace }), /:8$/);
  assert.deepEqual(registry.errors, []);
});

test("plugin definition and execution hooks share one deterministic registry pipeline", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-plugin-hooks-"));
  mkdirSync(join(workspace, ".khazai", "plugins"), { recursive: true });
  writeFileSync(join(workspace, ".khazai", "plugins", "decorate.js"), [
    "export default { hooks: {",
    '  "tool.definition": async (_context, value) => ({ ...value, description: `${value.description}!` }),',
    '  "tool.execute.before": async (_context, value) => ({ args: { ...value.args, decorated: true } }),',
    '  "tool.execute.after": async (_context, value) => ({ ...value, output: `${value.output}!` })',
    "} }",
  ].join("\n"));
  const registry = new Registry();
  registry.register({
    name: "echo",
    description: "Echo",
    parameters: { type: "object", properties: {} },
    execute: args => String(args.decorated),
  });
  await registry.load(workspace);
  assert.equal((await registry.definitions())[0].description, "Echo!");

  const lifecycle = new ToolLifecycle({ sessionId: "hooks", workspace });
  const executor = new ToolExecutor({
    registry,
    lifecycle,
    permissionService: new PermissionService(workspace, { permission: {} }),
    workspace,
    sessionId: "hooks",
  });
  let result;
  for await (const event of executor.execute({ name: "echo", args: {}, id: "call-hooks" })) {
    if (event.type === "execution-result") result = event.result;
  }
  assert.equal(result, "true!");
});

test("unified executor truncates large output and preserves the complete redacted file", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-truncate-"));
  const registry = new Registry();
  registry.register({
    name: "large",
    description: "large",
    parameters: { type: "object", properties: {} },
    execute: () => `token=secret-value\n${"x".repeat(60 * 1024)}`,
  });
  const lifecycle = new ToolLifecycle({ sessionId: "truncate-session", workspace });
  const executor = new ToolExecutor({
    registry,
    lifecycle,
    permissionService: new PermissionService(workspace, { permission: {} }),
    workspace,
    sessionId: "truncate-session",
  });
  let part;
  for await (const event of executor.execute({ name: "large", args: {}, id: "large-call" })) {
    if (event.type === "execution-result") part = event.part;
  }
  assert.equal(part.state.metadata.truncated, true);
  assert.equal(existsSync(part.state.metadata.outputPath), true);
  assert.equal(statSync(part.state.metadata.outputPath).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(part.state.metadata.outputPath, "utf-8"), /secret-value/);
});

test("unified executor enforces a bounded timeout", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-timeout-"));
  const registry = new Registry();
  registry.register({
    name: "slow",
    description: "slow",
    parameters: { type: "object", properties: {} },
    execute: () => new Promise(resolve => setTimeout(() => resolve("late"), 500)),
  });
  const executor = new ToolExecutor({
    registry,
    lifecycle: new ToolLifecycle({ sessionId: "timeout", workspace }),
    permissionService: new PermissionService(workspace, { permission: {} }),
    workspace,
    sessionId: "timeout",
    timeoutMs: 250,
  });
  let result;
  for await (const event of executor.execute({ name: "slow", args: {}, id: "slow-call" })) {
    if (event.type === "execution-result") result = event;
  }
  assert.equal(result.failed, true);
  assert.match(result.result, /timed out after 250ms/);
});

test("mixed mutation batches execute sequentially without provider reissue", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-mixed-batch-"));
  const registry = new Registry();
  const order = [];
  for (const name of ["first", "second"]) {
    registry.register({
      name,
      description: name,
      parameters: { type: "object", properties: {} },
      async execute() {
        order.push(name);
        return `${name} complete`;
      },
    });
  }
  let calls = 0;
  const agent = new Agent(registry, {
    workspace,
    intentResolver: async () => ({
      intent: "change",
      category: "MODIFICATION",
      operation: "modify_code",
      requiredEvidence: [],
      requiresPlan: false,
    }),
    chat: async (_messages, options) => {
      calls++;
      const result = calls === 1
        ? JSON.stringify([
            { tool: "first", args: {}, id: "one" },
            { tool: "second", args: {}, id: "two" },
          ])
        : "Both completed.";
      options.onToken?.(result);
      return result;
    },
  });
  for await (const _event of agent.loop("run both")) {}
  assert.deepEqual(order, ["first", "second"]);
  assert.equal(calls, 2);
});

test("legacy text parser stays disabled after a native tool-call event", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-native-gate-"));
  const registry = new Registry();
  let executions = 0;
  registry.register({
    name: "echo",
    description: "echo",
    parameters: { type: "object", properties: {} },
    execute: () => { executions++; return "executed"; },
  });
  let calls = 0;
  const agent = new Agent(registry, {
    workspace,
    chat: async (_messages, options) => {
      calls++;
      if (calls === 1) {
        options.onEvent?.({ type: "tool-call-delta", delta: [{ index: 0 }] });
        options.onEvent?.({ type: "finish", reason: "tool-calls" });
        return '<tool_call>{"tool":"echo","args":{}}</tool_call>';
      }
      options.onEvent?.({ type: "text-delta", text: "Recovered safely." });
      options.onEvent?.({ type: "finish", reason: "stop" });
      return "Recovered safely.";
    },
  });
  for await (const _event of agent.loop("test native gate")) {}
  assert.equal(calls, 2);
  assert.equal(executions, 0);
});

test("session v4 migration and lifecycle updates persist incrementally", () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-v3-work-"));
  const data = mkdtempSync(join(tmpdir(), "khazai-v3-data-"));
  const store = new SessionStore(workspace, data);
  const session = store.create();
  assert.equal(session.version, 4);

  const lifecycle = new ToolLifecycle({
    sessionId: session.id,
    workspace,
    onPart: part => store.updatePart(part.sessionId, part),
  });
  lifecycle.startStep("message-v3");
  const part = lifecycle.pending({ callId: "call-v3", tool: "read", input: { path: "a.js" } });
  lifecycle.running(part);
  lifecycle.completed(part, "source");
  lifecycle.finishStep("tool-calls");

  const loaded = store.load(session.id);
  assert.equal(loaded.version, 4);
  assert.equal(loaded.parts.find(item => item.callId === "call-v3").state.status, "completed");
  assert.equal(loaded.runtime.activeMessageId, null);
  const migrated = migrateSessionV3({ version: 2, id: "old", parts: [], agentState: { version: 2, parts: [] } });
  assert.equal(migrated.version, 3);
  assert.equal(migrated.agentState.version, 3);
  assert.deepEqual(migrateSessionV3(migrated), migrated);
  const v4 = migrateSessionV4({
    ...migrated,
    agentState: {
      ...migrated.agentState,
      messages: [
        { role: "user", content: "[INTERNAL STEERING]\nretry" },
        { role: "user", content: "real request" },
      ],
      taskContract: { intent: "change" },
    },
  });
  assert.equal(v4.version, 4);
  assert.equal(v4.agentState.version, 4);
  assert.deepEqual(v4.agentState.messages, [{ role: "user", content: "real request" }]);
  assert.equal("taskContract" in v4.agentState, false);
});

test("todowrite uses the unified runtime and emits a structured plan", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-todo-"));
  const registry = new Registry();
  registry.register(todoWriteTool);
  const responses = [
    JSON.stringify({
      tool: "todowrite",
      args: {
        todos: [
          { content: "Inspect files", status: "completed" },
          { content: "Run tests", status: "in_progress" },
        ],
      },
      id: "todo-call",
    }),
    "Plan updated.",
  ];
  const agent = new Agent(registry, {
    workspace,
    chat: async (_messages, options) => {
      const response = responses.shift();
      options.onToken?.(response);
      return response;
    },
  });
  const events = [];
  for await (const event of agent.loop("update the plan")) events.push(event);
  const plan = events.find(event => event.type === "plan");
  assert.deepEqual(plan.items, [
    { description: "Inspect files", status: "done" },
    { description: "Run tests", status: "running" },
  ]);
});
