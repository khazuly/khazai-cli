import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../app/agent.js";
import { Registry } from "../app/registry.js";
import { ExecutionPolicy } from "../app/execution-policy.js";
import { fallbackIntentContract } from "../app/intent-resolver.js";
import { redactSecrets } from "../lib/secrets.js";

const token = "ghp_123456789012345678901234567890123456";

test("git push completion requires Git evidence, not workspace mutation", () => {
  const contract = fallbackIntentContract("git push origin main");
  assert.equal(contract.operation, "git");
  assert.equal(contract.category, "GIT_OPERATION");
  assert.deepEqual(contract.requiredEvidence, ["git"]);
  const policy = new ExecutionPolicy(contract);
  policy.record("bash", { command: "git push origin main" }, "Exit: 0\nTo github.com:owner/repo.git", false);
  assert.equal(policy.completionDirective(), null);
});

test("credential follow-up uses temporary push path and never retains or emits the token", async () => {
  const agent = new Agent(new Registry(), { workspace: "/tmp/git-credential-test" });
  agent._pendingGitPush = { command: "git push origin main" };
  let receivedToken = null;
  agent._pushWithTemporaryCredential = async (command, value) => {
    receivedToken = value;
    assert.equal(command, "git push origin main");
    return { ok: true, result: "Exit: 0\nTo github.com:owner/repo.git" };
  };
  const events = [];
  for await (const event of agent.loop(`use this token ${token}`)) events.push(event);

  assert.equal(receivedToken, token);
  assert.equal(agent._pendingGitPush, null);
  assert.equal(agent._executionPolicy.completionDirective(), null);
  assert.equal(events.some(event => JSON.stringify(event).includes(token)), false);
  assert.equal(agent._messages.some(message => String(message.content).includes(token)), false);
  assert.match(agent._messages.findLast(message => message.role === "user").content, /\[REDACTED\]/);
});

test("authentication failure is clean and keeps no credential", async () => {
  const agent = new Agent(new Registry(), { workspace: "/tmp/git-credential-test" });
  agent._pendingGitPush = { command: "git push origin main" };
  agent._pushWithTemporaryCredential = async () => ({ ok: false, result: "Push failed because authentication was rejected." });
  const events = [];
  for await (const event of agent.loop(`token: ${token}`)) events.push(event);
  assert.equal(events.find(event => event.type === "answer")?.content, "Push failed because authentication was rejected.");
  assert.equal(events.some(event => JSON.stringify(event).includes(token)), false);
});

test("global redaction masks common credential forms", () => {
  const text = `token: ${token} Bearer abcdefghijklmnopqrstuvwxyz password=hunter2`;
  const safe = redactSecrets(text);
  assert.doesNotMatch(safe, new RegExp(token));
  assert.doesNotMatch(safe, /abcdefghijklmnopqrstuvwxyz|hunter2/);
  assert.match(safe, /\[REDACTED\]/);
});
