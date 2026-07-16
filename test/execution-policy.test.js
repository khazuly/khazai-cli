import assert from "node:assert/strict";
import test from "node:test";
import {
  ExecutionPolicy,
  destructiveCommand,
  inferTaskContract,
  inspectionCommand,
  validationCommand,
} from "../app/execution-policy.js";

test("task contracts distinguish conversation, inspection, mutation, deletion, and validation", () => {
  assert.deepEqual(inferTaskContract("hi").requiredEvidence, []);
  assert.deepEqual(inferTaskContract("explain this repository").requiredEvidence, ["inspection"]);
  assert.deepEqual(inferTaskContract("fix the bug in app.js").requiredEvidence, ["mutation"]);
  assert.deepEqual(inferTaskContract("delete old.py").requiredEvidence, ["deletion"]);
  assert.deepEqual(inferTaskContract("fix app.js and run tests").requiredEvidence, ["mutation", "validation"]);
  assert.deepEqual(inferTaskContract("push this change").requiredEvidence, ["git"]);
  assert.deepEqual(inferTaskContract("how do I run app.js?").requiredEvidence, ["validation"]);
  assert.equal(inferTaskContract("verify that this obfuscated output runs").intent, "validate");
  assert.deepEqual(inferTaskContract("verify that this obfuscated output runs").requiredEvidence, ["validation"]);
});

test("execution policy derives completion from successful evidence rather than model prose", () => {
  const policy = new ExecutionPolicy("fix app.js and run tests");
  assert.deepEqual(policy.completionGaps(), ["mutation", "validation"]);

  policy.record("edit", { path: "app.js" }, "Updated app.js", false);
  assert.deepEqual(policy.completionGaps(), ["validation"]);
  assert.equal(policy.phase, "verifying");

  policy.record("bash", { command: "npm test" }, "Exit: 1", true);
  assert.deepEqual(policy.completionGaps(), ["validation"]);
  assert.equal(policy.phase, "recovering");

  policy.record("bash", { command: "npm test" }, "Exit: 0", false);
  assert.equal(policy.canComplete(), true);
  assert.equal(policy.phase, "ready");
  assert.equal(policy.completionDirective(), null);
  assert.equal(policy.phase, "completed");
});

test("execution policy accepts contextual evidence supplied by the orchestrator", () => {
  const policy = new ExecutionPolicy({
    request: "create and validate a sample obfuscator",
    intent: "change",
    operation: "create",
    requiredEvidence: ["mutation", "validation"],
    modifiesFiles: true,
    validationRequested: true,
    createNewFiles: true,
    domain: "obfuscation",
  });
  policy.record("write", { path: "sample.py" }, "Written", false);
  policy.record(
    "bash",
    { command: "python3 obfuscator.py sample.py && python3 sample_obfuscated.py" },
    "Exit: 0",
    false,
    ["validation"],
  );

  assert.equal(policy.canComplete(), true);
});

test("command semantics separate inspection, deletion, and validation", () => {
  assert.equal(inspectionCommand("find . -type f | head -20"), true);
  assert.equal(destructiveCommand("find . -type f -delete"), true);
  assert.equal(inspectionCommand("find . -type f -delete"), false);
  assert.equal(validationCommand("npm install"), false);
  assert.equal(validationCommand("npm test"), true);
  assert.equal(validationCommand("node --check app.js"), true);
});

test("negated mutation does not create a false completion requirement", () => {
  const contract = inferTaskContract("review app.js but do not edit the file");
  assert.equal(contract.intent, "inspect");
  assert.deepEqual(contract.requiredEvidence, ["inspection"]);
});

test("research tasks require inspection evidence", () => {
  const policy = new ExecutionPolicy("explain this repository");
  assert.deepEqual(policy.completionGaps(), ["inspection"]);
  
  policy.record("read", { path: "README.md" }, "File contents", false);
  assert.equal(policy.canComplete(), true);
});

test("mutation tasks require mutation evidence", () => {
  const policy = new ExecutionPolicy("fix the bug in app.js");
  assert.deepEqual(policy.completionGaps(), ["mutation"]);
  
  policy.record("edit", { path: "app.js" }, "Fixed bug", false);
  assert.equal(policy.canComplete(), true);
});

test("validation tasks require validation evidence", () => {
  const policy = new ExecutionPolicy("run tests");
  assert.deepEqual(policy.completionGaps(), ["validation"]);
  
  policy.record("bash", { command: "npm test" }, "Exit: 0", false);
  assert.equal(policy.canComplete(), true);
});
