import assert from "node:assert/strict";
import test from "node:test";
import { definePlanItems, planCounts } from "../app/agent/plan.js";
import { todoWriteTool } from "../tools/todo.js";

const scope = { runId: "run-1", turnId: "turn-1", taskEpoch: 1 };

test("todowrite accepts OpenCode-compatible status aliases", async () => {
  const result = await todoWriteTool.execute({
    todos: [
      { content: "Inspect the workspace" },
      { content: "Make the change", status: "in progress" },
      { content: "Run tests", status: "done" },
      { content: "Defer docs", status: "cancelled" },
    ],
  });
  assert.deepEqual(result.metadata.todos.map(item => item.status), [
    "pending", "in_progress", "completed", "cancelled",
  ]);
});

test("a todo write replaces the session list without carrying stale progress", () => {
  const current = definePlanItems([
    { content: "Inspect files", status: "completed" },
    { content: "Implement change", status: "in_progress" },
  ], [], scope, "todos");
  const next = definePlanItems([
    { content: "Review the result", status: "pending" },
  ], current, { ...scope, turnId: "turn-2", taskEpoch: 2 }, "todos");
  assert.deepEqual(next.map(item => [item.description, item.status]), [["Review the result", "pending"]]);
  assert.deepEqual(planCounts(next), {
    completed: 0,
    in_progress: 0,
    pending: 1,
    cancelled: 0,
    total: 1,
  });
});

test("todo items retain model-selected concurrent progress states", () => {
  const items = definePlanItems([
    { content: "Update API", status: "in_progress" },
    { content: "Update UI", status: "in_progress" },
  ], [], scope, "todos");
  assert.deepEqual(items.map(item => item.status), ["in_progress", "in_progress"]);
});
