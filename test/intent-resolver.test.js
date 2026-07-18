import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { IntentResolver, fallbackIntentContract } from "../app/intent-resolver.js";

function classifierReturning(contract, captured = []) {
  return async (messages) => {
    captured.push(messages[0].content);
    return JSON.stringify(contract);
  };
}

test("semantic resolver maps a non-English request to a canonical contract", async () => {
  const resolver = new IntentResolver({
    classify: classifierReturning({
      intent: "validate",
      operation: "validate",
      continuation: "standalone",
      requiresPlan: false,
      requiredEvidence: ["validation"],
      requestedExtensions: [],
      modifiesFiles: false,
      validationRequested: true,
      allowMutationBeforeFailure: false,
      repairExistingOnFailure: true,
      createNewFiles: false,
      targetUrl: "",
      domain: "obfuscation",
    }),
  });

  const contract = await resolver.resolve({
    input: "coba jalankan hasil obfuscate ini",
    model: "claude",
  });

  assert.equal(contract.intent, "validate");
  assert.equal(contract.operation, "validate");
  assert.equal(contract.modifiesFiles, false);
  assert.equal(contract.repairExistingOnFailure, true);
  assert.deepEqual(contract.requiredEvidence, ["validation"]);
});

test("equivalent requests in different languages produce the same executable intent", async () => {
  const classify = classifierReturning({
    intent: "inspect",
    operation: "list_files",
    continuation: "standalone",
    requiredEvidence: ["inspection"],
  });
  const resolver = new IntentResolver({ classify });
  const english = await resolver.resolve({ input: "list the files here" });
  const indonesian = await resolver.resolve({ input: "cek file yang ada di sini" });

  assert.equal(english.intent, indonesian.intent);
  assert.equal(english.operation, indonesian.operation);
  assert.deepEqual(english.requiredEvidence, indonesian.requiredEvidence);
});

test("malformed classifier output falls back to a safe destructive contract for an explicit deletion", async () => {
  const resolver = new IntentResolver({ classify: async () => "not json" });
  const contract = await resolver.resolve({ input: "create and delete something" });

  assert.equal(contract.intent, "delete");
  assert.equal(contract.category, "DESTRUCTIVE_OPERATION");
  assert.equal(contract.uncertain, false);
  assert.equal(contract.modifiesFiles, false);
  assert.deepEqual(contract.requiredEvidence, ["deletion"]);
});

test("classifier instructions are language-neutral while fallback stays English-only", async () => {
  const captured = [];
  const resolver = new IntentResolver({ classify: classifierReturning({ intent: "answer", operation: "answer" }, captured) });
  await resolver.resolve({ input: "anything" });
  assert.match(captured[0], /regardless of its language/i);

  const contract = fallbackIntentContract("fix app.js with a patch; do not rewrite it");
  assert.equal(contract.intent, "change");
  assert.equal(contract.category, "MODIFICATION");
});

test("English-only fallback remains conservative and deterministic", () => {
  const inspect = fallbackIntentContract("list files in this directory");
  const change = fallbackIntentContract("fix app.js and run tests");
  assert.equal(inspect.operation, "list_files");
  assert.deepEqual(change.requiredEvidence, ["mutation", "validation"]);
});

test("endpoint discovery with a bare domain uses a research contract", () => {
  const contract = fallbackIntentContract("discover endpoints at aichat.org");
  assert.equal(contract.intent, "research");
  assert.equal(contract.operation, "discover_endpoints");
  assert.equal(contract.targetUrl, "aichat.org");
});
