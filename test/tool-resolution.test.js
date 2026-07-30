import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../app/agent.js";
import { PermissionService } from "../app/permission.js";
import { Registry } from "../app/registry.js";
import { ToolExecutor } from "../app/tool-executor.js";
import { ToolLifecycle } from "../app/tool-lifecycle.js";

function executor(registry, workspace, scope = {}) {
  return new ToolExecutor({
    registry,
    lifecycle: new ToolLifecycle({ sessionId: "tool-resolution", workspace }),
    permissionService: new PermissionService(workspace, { permission: {} }),
    workspace,
    sessionId: "tool-resolution",
    ...scope,
  });
}

test("registered tool aliases resolve before execution", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-tool-alias-"));
  const registry = new Registry();
  registry.register({
    name: "bash",
    aliases: ["shell_find"],
    description: "Shell",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
    execute: ({ command }) => `ran:${command}`,
  });
  const events = [];
  for await (const event of executor(registry, workspace).execute({
    name: "shell_find",
    args: { command: "find ." },
    id: "alias-call",
  })) {
    events.push(event);
  }
  assert.equal(registry.resolveName("shell_find"), "bash");
  assert.deepEqual(
    events.filter(event => event.type === "tool-part").map(event => [
      event.part.tool,
      event.part.state.status,
    ]),
    [["bash", "pending"], ["bash", "running"], ["bash", "completed"]],
  );
});

test("unknown tools emit one terminal structured result without pending state", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-unknown-tool-"));
  const registry = new Registry();
  for (const name of ["read", "bash"]) {
    registry.register({
      name,
      description: name,
      parameters: { type: "object", properties: {} },
      execute: () => name,
    });
  }
  const events = [];
  for await (const event of executor(registry, workspace, {
    runId: "run-unknown",
    turnId: "turn-unknown",
    taskEpoch: 3,
  }).execute({
    name: "shell_find",
    args: { path: "." },
    id: "unknown-call",
  })) {
    events.push(event);
  }
  const parts = events.filter(event => event.type === "tool-part");
  assert.equal(parts.length, 1);
  assert.equal(parts[0].part.tool, "unknown_tool");
  assert.equal(parts[0].part.state.status, "error");
  assert.equal(parts[0].runId, "run-unknown");
  assert.equal(parts[0].turnId, "turn-unknown");
  assert.equal(parts[0].taskEpoch, 3);
  assert.equal(events.some(event => event.type === "permission"), false);
  assert.deepEqual(JSON.parse(events.find(event => event.type === "tool-result").result), {
    code: "UNKNOWN_TOOL",
    requestedTool: "shell_find",
    availableTools: ["read", "bash"],
  });
});

test("repeated unknown tools stop after one terminal row and preserve Plan state", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-unknown-tool-flow-"));
  const registry = new Registry();
  registry.register({
    name: "read",
    description: "read",
    parameters: { type: "object", properties: {} },
    async execute() { return "read"; },
  });
  let calls = 0;
  let continuationMessages = [];
  const agent = new Agent(registry, {
    workspace,
    intentResolver: async ({ input }) => ({
      intent: "change",
      category: "MODIFICATION",
      operation: "modify_code",
      requiredEvidence: ["mutation"],
      requiresPlan: false,
      raw: input,
    }),
    chat: async messages => {
      calls++;
      if (calls === 2) continuationMessages = messages;
      return JSON.stringify({
        tool: "shell_find",
        args: { path: "." },
        id: `unknown-${calls}`,
      });
    },
  });
  const events = [];
  for await (const event of agent.loop("inspect the workspace")) events.push(event);
  const unknownParts = events.filter(event =>
    event.type === "tool-part" && event.part?.tool === "unknown_tool"
  );
  assert.equal(calls, 2);
  assert.deepEqual(unknownParts.map(event => event.part.state.status), ["error"]);
  assert.equal(events.some(event =>
    event.type === "tool-call" && event.tool === "shell_find"
  ), false);
  const toolResult = continuationMessages.find(message =>
    message.role === "tool" && message.name === "shell_find"
  );
  assert.deepEqual(JSON.parse(toolResult.content), {
    code: "UNKNOWN_TOOL",
    requestedTool: "shell_find",
    availableTools: ["read"],
  });
  assert.equal(events.some(event =>
    event.type === "plan-update" && event.status === "done"
  ), false);
});

test("duplicate unknown tools in one batch produce one terminal result", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-unknown-tool-batch-"));
  let calls = 0;
  const agent = new Agent(new Registry(), {
    workspace,
    chat: async () => {
      calls++;
      if (calls === 1) {
        return JSON.stringify([
          { name: "shell_find", arguments: { path: "." }, id: "unknown-a" },
          { name: "shell_find", arguments: { path: "." }, id: "unknown-b" },
        ]);
      }
      return "Stopped after the invalid tool result.";
    },
  });
  const events = [];
  for await (const event of agent.loop("inspect the workspace")) events.push(event);
  assert.equal(calls, 2);
  assert.equal(events.filter(event =>
    event.type === "tool-part" && event.part?.tool === "unknown_tool"
  ).length, 1);
});
