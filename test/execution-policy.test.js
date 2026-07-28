import assert from "node:assert/strict";
import test from "node:test";
import {
  ExecutionPolicy,
  destructiveCommand,
  inspectionCommand,
  validationCommand,
} from "../app/execution-policy.js";

test("execution policy tracks required evidence and completion gaps", () => {
  const policy = new ExecutionPolicy("fix app.js and run tests");
  // Contract requires mutation evidence (change intent)
  assert.ok(policy.completionGaps().length > 0, "should report missing mutation evidence before any mutation");
  policy.record("edit", { path: "app.js" }, "Edited", false);
  // edit tool counts as mutation evidence
  assert.ok(policy.mutatedWorkspace, "edit tool counts as mutation");
  assert.ok(!policy.completionGaps().some(g => g.kind === "mutation"), "mutation evidence filled by edit");
  policy.record("bash", { command: "echo fix" }, "fixed", false);
  policy.record("bash", { command: "npm test" }, "Exit: 0", false);
  assert.ok(policy.ranValidation, "should track validation from npm test");
  assert.equal(policy.canComplete(), true, "should be completable once all required evidence is present");
  assert.equal(policy.completionSteering(), null, "no steering when gaps are filled");
});

test("completionSteering returns guidance when evidence is missing", () => {
  const policy = new ExecutionPolicy("fix app.js and run tests");
  const steering = policy.completionSteering();
  assert.ok(steering, "should return steering when required evidence is missing");
  assert.ok(steering.guidance, "steering should have guidance");
  assert.ok(steering.recommendedAction, "steering should have recommendedAction");
  assert.equal(steering.detectedIntent, "change");
});

test("execution policy with no required evidence always completes", () => {
  const policy = new ExecutionPolicy("what is 2+2");
  assert.deepEqual(policy.completionGaps(), []);
  assert.equal(policy.canComplete(), true);
  assert.equal(policy.completionSteering(), null);
});

test("completion gaps reflect the latest outcome for required verification", () => {
  const policy = new ExecutionPolicy("fix app.js and run tests");
  policy.record("edit", { path: "app.js" }, "Edited", false);
  policy.record("bash", { command: "npm test" }, "Exit: 1", true);
  assert.equal(policy.completionGaps().some(gap => gap.kind === "validation"), true);

  policy.record("bash", { command: "npm test" }, "Exit: 0", false);
  assert.equal(policy.completionGaps().some(gap => gap.kind === "validation"), false);

  policy.record("bash", { command: "npm test" }, "Exit: 1", true);
  assert.equal(policy.completionGaps().some(gap => gap.kind === "validation"), true);
});

test("contextBlock includes phase and evidence summary", () => {
  const policy = new ExecutionPolicy("fix app.js");
  const block = policy.contextBlock();
  assert.ok(block.includes("Intent: change"), "should include intent");
  assert.ok(block.includes("Category: MODIFICATION"), "should include category");
  assert.ok(block.includes("Required evidence: mutation"), "should include required evidence");
  assert.ok(block.includes("Collected: none"), "should show no collected evidence");
  policy.record("write", { path: "app.js" }, "Written", false);
  const block2 = policy.contextBlock();
  assert.ok(block2.includes("mutated"), "should show mutation collected");
});

test("command helpers remain available for presentation and permission parsing", () => {
  assert.equal(inspectionCommand("find . -type f | head -20"), true);
  assert.equal(destructiveCommand("find . -type f -delete"), true);
  assert.equal(inspectionCommand("find . -type f -delete"), false);
  assert.equal(validationCommand("npm install"), false);
  assert.equal(validationCommand("npm test"), true);
  assert.equal(validationCommand("node --check app.js"), true);
  assert.equal(validationCommand(
    "curl -s -X POST https://example.com/login -d '{\"email\":\"test@test.com\",\"password\":\"test123\"}'",
  ), false);
});
