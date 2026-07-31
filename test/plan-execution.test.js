import assert from "node:assert/strict";
import test from "node:test";
import {
  associatePlanStep,
  canTransition,
  definePlanItems,
  settlePlanStep,
} from "../app/agent/plan.js";

const scope = {
  runId: "run-current",
  turnId: "turn-current",
  taskEpoch: 4,
};

function plan(todos) {
  return definePlanItems(todos, [], scope, "plan-evidence");
}

function runTool(items, tool, result = "Exit: 0\n1 test passed", succeeded = true, activeScope = scope) {
  const tracker = associatePlanStep(items, tool, activeScope);
  return {
    tracker,
    settled: settlePlanStep(tracker, tool, result, succeeded, activeScope),
  };
}

test("model completion flags cannot complete Plan items", () => {
  const items = plan([
    { content: "Explore the command architecture", status: "completed" },
    { content: "Implement the command", status: "completed" },
    { content: "Run tests", status: "completed" },
  ]);
  assert.deepEqual(items.map(item => item.status), ["pending", "pending", "pending"]);
  assert.equal(items.every(item => item.evidenceIds.length === 0), true);
});

test("Read and Search evidence can complete only exploration", () => {
  const items = plan([
    { content: "Explore relevant files", status: "pending" },
    { content: "Implement the fix", status: "pending" },
  ]);
  const read = { id: "read-1", name: "read", args: { path: "app.js" } };
  const { settled } = runTool(items, read, "source", true);
  assert.equal(settled.step.status, "done");
  assert.deepEqual(items.map(item => item.status), ["done", "pending"]);

  const search = { id: "grep-1", name: "grep", args: { pattern: "Plan" } };
  assert.equal(associatePlanStep(items, search, scope), null);
  assert.equal(items[1].status, "pending");
});

test("successful Edit completes only its associated implementation step", () => {
  const items = plan([
    { content: "Implement the Plan validator", status: "pending" },
    { content: "Register the command", status: "pending" },
  ]);
  const edit = { id: "edit-1", name: "edit", args: { path: "app/plan.js" } };
  const { settled } = runTool(items, edit, "Updated app/plan.js", true);
  assert.equal(settled.step.id, items[0].id);
  assert.deepEqual(items.map(item => item.status), ["done", "pending"]);
});

test("zero-test and timed-out verification results do not complete verification", () => {
  for (const [id, output] of [
    ["zero-tests", "Exit: 0\n0 passed, 0 failed"],
    ["timeout", "Exit: -1\nTest suite timed out after 120s"],
  ]) {
    const items = plan([{ content: "Run tests", status: "pending" }]);
    const bash = { id, name: "bash", args: { command: "npm test" } };
    const { settled } = runTool(items, bash, output, !output.includes("Exit: -1"));
    assert.equal(settled.step.status, "failed");
    assert.deepEqual(settled.step.evidenceIds, []);
  }
});

test("stale evidence cannot change the active Plan", () => {
  const items = plan([{ content: "Implement the fix", status: "pending" }]);
  const edit = { id: "stale-edit", name: "edit", args: { path: "app.js" } };
  const tracker = associatePlanStep(items, edit, scope);
  const staleScope = { ...scope, runId: "run-old" };
  assert.equal(settlePlanStep(tracker, edit, "updated", true, staleScope), null);
  assert.equal(items[0].status, "running");
});

test("Plan reaches N/N only after every step has matching successful evidence", () => {
  const items = plan([
    { content: "Inspect files", status: "pending" },
    { content: "Implement the fix", status: "pending" },
    { content: "Run tests", status: "pending" },
  ]);
  runTool(items, { id: "read", name: "read", args: {} }, "source", true);
  runTool(items, { id: "edit", name: "edit", args: {} }, "updated", true);
  runTool(items, { id: "test", name: "bash", args: { command: "npm test" } }, "Exit: 0\n2 passed, 0 failed", true);
  assert.equal(items.every(item => item.status === "done" && item.evidenceIds.length === 1), true);
});

test("transition validator rejects completion without associated evidence", () => {
  const [step] = plan([{ content: "Implement the fix", status: "pending" }]);
  assert.equal(canTransition(step, "done"), false);
  assert.equal(canTransition(step, "running"), true);
});

test("Plan revisions retain completed evidence and failed steps accept a valid retry", () => {
  const items = plan([
    { content: "Inspect files", status: "pending" },
    { content: "Implement the fix", status: "pending" },
  ]);
  runTool(items, { id: "read-first", name: "read", args: {} }, "source", true);
  const revised = definePlanItems([
    { content: "Implement the focused fix", status: "pending" },
  ], items, scope, "plan-evidence");
  assert.equal(revised[0].description, "Inspect files");
  assert.equal(revised[0].status, "done");
  assert.equal(revised[0].evidenceIds.length, 1);

  const edit = { id: "edit-failed", name: "edit", args: {} };
  runTool(revised, edit, "permission denied", false);
  const retry = { id: "edit-retry", name: "edit", args: {} };
  const { settled } = runTool(revised, retry, "updated", true);
  assert.equal(settled.step.status, "done");
});
