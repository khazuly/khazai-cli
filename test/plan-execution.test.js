import assert from "node:assert/strict";
import test from "node:test";
import { applyPlanSnapshot, EMPTY_PLAN_STATE, normalizePlanState, validatePlanState } from "../app/agent/plan.js";

test("todo snapshots preserve model statuses without evidence requirements", () => {
  const state = normalizePlanState({
    planId: "todos-1",
    revision: 1,
    runId: "run-1",
    turnId: "turn-1",
    taskEpoch: 1,
    items: [
      { content: "Inspect", status: "completed" },
      { content: "Implement", status: "in_progress" },
      { content: "Verify", status: "pending" },
    ],
  });
  assert.deepEqual(state.steps.map(item => item.status), ["completed", "in_progress", "pending"]);
  assert.equal(state.currentStepId, null);
  assert.equal(validatePlanState(state).ok, true);
});

test("new todo snapshots replace prior lists and ignore stale revisions", () => {
  const initial = applyPlanSnapshot(EMPTY_PLAN_STATE, {
    planId: "todos-1",
    revision: 1,
    items: [{ content: "Inspect", status: "completed" }],
  }, true);
  const stale = applyPlanSnapshot(initial, {
    planId: "todos-1",
    revision: 1,
    items: [{ content: "Stale", status: "pending" }],
  }, true);
  const replacement = applyPlanSnapshot(initial, {
    planId: "todos-2",
    revision: 1,
    items: [{ content: "New task", status: "pending" }],
  }, true);
  assert.equal(stale, initial);
  assert.deepEqual(replacement.steps.map(item => item.description), ["New task"]);
});
