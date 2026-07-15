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

test("endpoint discovery requires JavaScript asset inspection evidence", () => {
  const policy = new ExecutionPolicy({
    intent: "research",
    operation: "discover_endpoints",
    requiredEvidence: ["research"],
    domain: "web",
    targetUrl: "https://fixture-chat.example",
  });

  assert.deepEqual(policy.completionGaps(), ["research", "endpoint_inspection", "endpoint_asset_inspection"]);
  policy.record(
    "bash",
    { command: "curl -Ls https://fixture-chat.example | head -80" },
    "Exit: 0\n<!doctype html>\n<a href=\"/chat\">chat</a>",
    false,
  );
  assert.deepEqual(policy.completionGaps(), ["endpoint_asset_inspection"]);
  assert.equal(policy.canComplete(), false);

  policy.record(
    "bash",
    { command: "tmp=$(mktemp -d /tmp/khazai-endpoints-XXXXXX); curl -Ls https://fixture-chat.example/assets/app.js > \"$tmp/app.js\"; rg \"fetch|/api|chat\" \"$tmp\"" },
    "Exit: 0\nJS chars 42000 from https://fixture-chat.example/assets/app.js\nfetch('/api/chat', { method: 'POST' })\n[POST] /api/chat",
    false,
  );
  assert.equal(policy.canComplete(), true);
});

test("endpoint asset evidence accepts natural shell bundle scans with quoted API paths", () => {
  const policy = new ExecutionPolicy({
    intent: "research",
    operation: "discover_endpoints",
    requiredEvidence: ["research"],
    domain: "web",
    targetUrl: "https://login-fixture.example",
  });

  policy.record(
    "bash",
    {
      command: "cd /tmp && curl -s 'https://cdn.login-fixture.example/assets/bundle.123.js' | grep -oE '\"(/api/v4/[a-z0-9_/]+)\"' | grep -E '(login|auth)'",
    },
    [
      "Exit: 0",
      "\"/api/v4/account/login_by_password\"",
      "\"/api/v4/account/login_by_otp\"",
      "\"/api/v4/authentication/login_by_google\"",
    ].join("\n"),
    false,
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
