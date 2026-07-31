import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Agent } from "../app/agent.js";
import { Registry } from "../app/registry.js";
import {
  associatePlanStep,
  canTransition,
  definePlanItems,
  selectNextActiveStep,
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

function trackerFor(items, stepId, toolCallId) {
  return { plan: items, stepId, toolCallId, ...scope };
}

/**
 * Mirrors the execution controller: associate the tool, settle it, then
 * advance to the next eligible step when the current step completed.
 */
function runTool(items, tool, result = "Exit: 0\n1 test passed", succeeded = true, activeScope = scope) {
  const tracker = associatePlanStep(items, tool, activeScope);
  const settled = settlePlanStep(tracker, tool, result, succeeded, activeScope);
  if (settled?.step.status === "completed") {
    const next = selectNextActiveStep(items);
    if (next) {
      next.status = "active";
      next.startedAt ||= Date.now();
    }
  }
  return { tracker, settled };
}

const INIT_STEPS = [
  "Explore current `/init` flow and relevant architecture",
  "Design dedicated repository initialization task",
  "Refactor the generator",
  "Refactor the preview UI",
  "Wire `/init` commands",
  "Add tests",
  "Run typecheck, lint, build, and tests",
];

test("model completion flags cannot complete Plan items", () => {
  const items = plan([
    { content: "Explore the command architecture", status: "completed" },
    { content: "Implement the command", status: "completed" },
    { content: "Run tests", status: "completed" },
  ]);
  assert.deepEqual(items.map(item => item.status), ["active", "pending", "pending"]);
  assert.equal(items.every(item => item.evidenceIds.length === 0), true);
  assert.equal(items[0].status, "active", "only execution state may activate a step");
});

test("Step 2 is active while Step 7 remains pending", () => {
  const items = plan(INIT_STEPS.map(description => ({ content: description, status: "pending" })));
  // Fresh definition: only the first step is active.
  assert.deepEqual(items.map(item => item.status), [
    "active", "pending", "pending", "pending", "pending", "pending", "pending",
  ]);
  assert.deepEqual(items.map(item => item.evidenceIds), [[], [], [], [], [], [], []]);

  // Step 1 completes on exploration evidence; step 2 becomes active and
  // step 7 stays pending because implementation/verification never ran.
  runTool(items, { id: "read-1", name: "read", args: { path: "app/init.js" } }, "source", true);
  assert.deepEqual(items.map(item => item.status), [
    "completed", "active", "pending", "pending", "pending", "pending", "pending",
  ]);
  assert.equal(items[1].status, "active");
  assert.equal(items[6].status, "pending");
  assert.equal(items[6].evidenceIds.length, 0);
  assert.equal(items.filter(item => item.status === "active").length, 1);
});

test("Read and Search evidence can complete only exploration", () => {
  const items = plan([
    { content: "Explore relevant files", status: "pending" },
    { content: "Implement the fix", status: "pending" },
  ]);
  const read = { id: "read-1", name: "read", args: { path: "app.js" } };
  const { settled } = runTool(items, read, "source", true);
  assert.equal(settled.step.status, "completed");
  assert.deepEqual(items.map(item => item.status), ["completed", "active"]);

  const search = { id: "grep-1", name: "grep", args: { pattern: "Plan" } };
  assert.equal(associatePlanStep(items, search, scope), null);
  assert.equal(items[1].status, "active");
});

test("successful Edit completes only its associated implementation step", () => {
  const items = plan([
    { content: "Implement the Plan validator", status: "pending" },
    { content: "Register the command", status: "pending" },
  ]);
  const edit = { id: "edit-1", name: "edit", args: { path: "app/plan.js" } };
  const { settled } = runTool(items, edit, "Updated app/plan.js", true);
  assert.equal(settled.step.id, items[0].id);
  assert.deepEqual(items.map(item => item.status), ["completed", "active"]);
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

test("inspection Shell commands cannot complete verification", () => {
  const items = plan([{ content: "Run typecheck, lint, build, and tests", status: "pending" }]);
  for (const command of ["ls -la", "grep -r init app", "head -40 app/init.js", "cat package.json"]) {
    const bash = { id: `bash-${command}`, name: "bash", args: { command } };
    // An unrelated successful shell command may not even associate with the
    // verification step, and it must never complete it.
    const tracker = associatePlanStep(items, bash, scope);
    const settled = settlePlanStep(tracker, bash, "Exit: 0\n", true, scope);
    assert.equal(settled, null);
    assert.equal(items[0].status, "active");
    assert.equal(items[0].evidenceIds.length, 0);
  }
  const real = { id: "bash-test", name: "bash", args: { command: "npm test" } };
  const { settled } = runTool(items, real, "Exit: 0\n3 passed, 0 failed", true);
  assert.equal(settled.step.status, "completed");
});

test("a future step cannot complete before dependencies", () => {
  const items = plan([
    { content: "Explore relevant files", status: "pending" },
    { content: "Implement the fix", status: "pending" },
    { content: "Run tests", status: "pending" },
  ]);
  // Direct transition validation: pending -> completed is rejected.
  assert.equal(canTransition(items[2], "completed", { valid: true, stepId: items[2].id }), false);

  // The tool for step 3 cannot activate it while step 1 is the active step.
  const edit = { id: "edit-early", name: "edit", args: { path: "app.js" } };
  assert.equal(associatePlanStep(items, edit, scope), null);
  assert.deepEqual(items.map(item => item.status), ["active", "pending", "pending"]);

  // Even if a future step were active, incomplete dependencies block its
  // completion.
  items[2].status = "active";
  items[2].activeToolCallId = "bash-early";
  const bash = { id: "bash-early", name: "bash", args: { command: "npm test" } };
  const settled = settlePlanStep(
    trackerFor(items, items[2].id, "bash-early"),
    bash,
    "Exit: 0\n2 passed, 0 failed",
    true,
    scope,
  );
  assert.equal(settled, null);
  assert.equal(items[2].status, "active");
  assert.equal(items[2].evidenceIds.length, 0);

  // Restore ordered execution: step 1 completes, step 2 becomes active, and
  // step 3 stays pending until its dependencies complete.
  items[2].status = "pending";
  items[2].activeToolCallId = null;
  runTool(items, { id: "read-1", name: "read", args: {} }, "source", true);
  assert.deepEqual(items.map(item => item.status), ["completed", "active", "pending"]);
  runTool(items, { id: "edit-2", name: "edit", args: {} }, "updated", true);
  assert.deepEqual(items.map(item => item.status), ["completed", "completed", "active"]);
});

test("only the tool associated with a step may provide its evidence", () => {
  const items = plan([
    { content: "Explore relevant files", status: "pending" },
    { content: "Refactor the generator", status: "pending" },
  ]);
  runTool(items, { id: "read-1", name: "read", args: {} }, "source", true);
  assert.deepEqual(items.map(item => item.status), ["completed", "active"]);
  items[1].activeToolCallId = "edit-2";

  // A read cannot associate with the active implementation step, so it can
  // never provide its evidence.
  const read = { id: "read-2", name: "read", args: { path: "app.js" } };
  assert.equal(associatePlanStep(items, read, scope), null);
  assert.equal(items[1].status, "active");
  assert.equal(items[1].evidenceIds.length, 0);

  // Only the associated edit (matching activeToolCallId) may complete it.
  const edit = { id: "edit-2", name: "edit", args: { path: "app/init.js" } };
  const tracker = associatePlanStep(items, edit, scope);
  assert.equal(tracker?.stepId, items[1].id);
  const otherEdit = { id: "edit-stale", name: "edit", args: { path: "app/init.js" } };
  assert.equal(
    settlePlanStep(trackerFor(items, items[1].id, otherEdit.id), otherEdit, "updated", true, scope),
    null,
  );
  const completed = settlePlanStep(tracker, edit, "updated", true, scope);
  assert.equal(completed.step.status, "completed");
  assert.equal(completed.step.evidenceIds.length, 1);
});

test("stale callbacks cannot alter the current Plan", () => {
  const items = plan([{ content: "Implement the fix", status: "pending" }]);
  const edit = { id: "stale-edit", name: "edit", args: { path: "app.js" } };
  const tracker = associatePlanStep(items, edit, scope);
  const staleScope = { ...scope, runId: "run-old" };
  assert.equal(settlePlanStep(tracker, edit, "updated", true, staleScope), null);
  assert.equal(items[0].status, "active");

  // A completed step cannot be flipped back to active by a stale callback.
  runTool(items, edit, "updated", true);
  assert.equal(items[0].status, "completed");
  assert.equal(canTransition(items[0], "active"), false);
  assert.equal(associatePlanStep(items, edit, scope), null);
  assert.equal(items[0].status, "completed");
});

test("Plan reaches N/N only after every step has matching successful evidence", () => {
  const items = plan(INIT_STEPS.map(description => ({ content: description, status: "pending" })));
  const read = { id: "read", name: "read", args: {} };
  const edit = { id: "edit", name: "edit", args: {} };
  const test = { id: "test", name: "bash", args: { command: "npm test" } };

  runTool(items, read, "source", true); // 1. Explore
  runTool(items, read, "source", true); // 2. Design (exploration evidence)
  runTool(items, edit, "updated", true); // 3. Refactor generator
  runTool(items, edit, "updated", true); // 4. Refactor preview UI
  runTool(items, edit, "updated", true); // 5. Wire /init commands
  runTool(items, edit, "updated", true); // 6. Add tests
  runTool(items, test, "Exit: 0\n7 passed, 0 failed", true); // 7. Verification

  assert.deepEqual(items.map(item => item.status), [
    "completed", "completed", "completed", "completed", "completed", "completed", "completed",
  ]);
  assert.equal(items.every(item => item.evidenceIds.length === 1), true);
  // The counter counts completed steps only.
  assert.equal(items.filter(item => item.status === "completed").length, 7);
});

test("transition validator rejects completion without associated evidence", () => {
  const [step] = plan([{ content: "Implement the fix", status: "pending" }]);
  step.status = "pending";
  assert.equal(canTransition(step, "completed"), false);
  assert.equal(canTransition(step, "active"), true);
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
  assert.equal(revised[0].status, "completed");
  assert.equal(revised[0].evidenceIds.length, 1);

  const edit = { id: "edit-failed", name: "edit", args: {} };
  runTool(revised, edit, "permission denied", false);
  assert.equal(revised.at(-1).status, "failed");
  const retry = { id: "edit-retry", name: "edit", args: {} };
  const { settled } = runTool(revised, retry, "updated", true);
  assert.equal(settled.step.status, "completed");
});

function applyPlanUpdates(initial, updates) {
  const items = initial.map(item => ({ ...item }));
  for (const update of updates) {
    for (const item of items) {
      if (item.stepId === update.stepId || item.id === update.stepId) item.status = update.status;
    }
  }
  return items;
}

test("approved /init plan renders Step 2 active while Step 7 stays pending, then reaches 7/7", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-plan-init-"));
  const registry = new Registry();
  registry.register({
    name: "read",
    description: "Read a file.",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    async execute() { return "source"; },
  });
  registry.register({
    name: "edit",
    description: "Edit a file.",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    async execute() { return "Updated file."; },
  });
  registry.register({
    name: "bash",
    description: "Run a shell command.",
    parameters: { type: "object", properties: { command: { type: "string" } } },
    async execute() { return "Exit: 0\n7 passed, 0 failed"; },
  });
  const calls = [
    { tool: "read", args: { path: "app/init.js" } },
    { tool: "read", args: { path: "lib/init-task.js" } },
    { tool: "edit", args: { path: "app/init-task.js" } },
    { tool: "edit", args: { path: "ui/init-preview.js" } },
    { tool: "edit", args: { path: "app/commands.js" } },
    { tool: "edit", args: { path: "test/init-task.test.js" } },
    { tool: "bash", args: { command: "npm test" } },
  ];
  const responses = calls.map((call, index) => JSON.stringify({
    tool: call.tool,
    args: call.args,
    id: `${call.tool}-${index + 1}`,
  }));
  responses.push("Init flow implemented.");
  const agent = new Agent(registry, {
    workspace,
    chat: async (_messages, options) => {
      const response = responses.shift();
      options.onToken?.(response);
      return response;
    },
  });
  const events = [];
  for await (const event of agent.loop("implement the /init flow", undefined, {
    approvedPlan: { planId: "plan-init-7", steps: INIT_STEPS },
  })) events.push(event);
  const plan = events.find(event => event.type === "plan");
  assert.equal(plan.planId, "plan-init-7");
  assert.equal(plan.items.length, 7);
  assert.equal(plan.currentStepId, plan.items[0].id);

  // After the first exploration tool completes, Step 2 is active, Step 7 is
  // still pending, and the counter counts only completed steps: 1/7.
  const updates = events.filter(event => event.type === "plan-update");
  const afterFirst = applyPlanUpdates(plan.items, updates.filter(u => (
    u.stepId === plan.items[0].id
    || (u.stepId === plan.items[1].id && u.status === "active")
  )));
  assert.deepEqual(afterFirst.map(item => item.status), [
    "completed", "active", "pending", "pending", "pending", "pending", "pending",
  ]);
  const completedCount = afterFirst.filter(item => item.status === "completed").length;
  assert.equal(completedCount, 1, "Plan counter must count completed steps only");
  assert.equal(afterFirst[6].status, "pending", "Step 7 must stay pending");

  // Every plan-update carries the guards needed to reject stale callbacks.
  for (const update of updates) {
    assert.equal(typeof update.planId, "string");
    assert.equal(typeof update.stepId, "string");
    assert.equal(typeof update.toolCallId, "string");
    assert.equal(typeof update.currentStepId, "string");
    assert.equal(typeof update.runId, "string");
    assert.equal(typeof update.turnId, "string");
    assert.equal(typeof update.taskEpoch, "number");
  }

  // Only real implementation and verification evidence reach 7/7.
  const finalPlan = events.filter(event => event.type === "plan").at(-1).items;
  const finalStates = applyPlanUpdates(finalPlan, updates);
  assert.deepEqual(finalStates.map(item => item.status), [
    "completed", "completed", "completed", "completed", "completed", "completed", "completed",
  ]);
  assert.equal(finalStates.every(item => item.evidenceIds.length === 1), true);
  assert.equal(finalStates.filter(item => item.status === "completed").length, 7);
});
