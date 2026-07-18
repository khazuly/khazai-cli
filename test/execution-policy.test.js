import assert from "node:assert/strict";
import test from "node:test";
import {
  ExecutionPolicy,
  destructiveCommand,
  inspectionCommand,
  validationCommand,
} from "../app/execution-policy.js";

test("legacy execution policy no longer gates model completion", () => {
  const policy = new ExecutionPolicy("fix app.js and run tests");
  assert.deepEqual(policy.completionGaps(), []);
  assert.equal(policy.canComplete(), true);
  policy.record("edit", { path: "app.js" }, "Edited", false);
  assert.deepEqual(policy.completionGaps(), []);
  policy.record("bash", { command: "npm test" }, "Exit: 1", true);
  assert.equal(policy.canComplete(), true);
  assert.equal(policy.completionSteering(), null);
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
