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

test("credential text follows the normal model path without bespoke Git interception", async () => {
  let receivedMessages = [];
  const agent = new Agent(new Registry(), {
    workspace: "/tmp/git-credential-test",
    chat: async messages => {
      receivedMessages = messages;
      return "Configure Git authentication, then retry the push.";
    },
  });
  agent._pendingGitPush = { command: "git push origin main" };
  let intercepted = false;
  agent._pushWithTemporaryCredential = async () => {
    intercepted = true;
    return { ok: true, result: "unexpected" };
  };
  const events = [];
  for await (const event of agent.loop(`use this token ${token}`)) events.push(event);

  assert.equal(intercepted, false);
  assert.equal(agent._pendingGitPush, null);
  assert.equal(events.some(event => JSON.stringify(event).includes(token)), false);
  assert.equal(JSON.stringify(receivedMessages).includes(token), false);
  assert.equal(agent._messages.some(message => String(message.content).includes(token)), false);
  assert.match(agent._messages.findLast(message => message.role === "user").content, /\[REDACTED\]/);
});

test("credential-like input is redacted before the provider sees it", async () => {
  let providerInput = "";
  const agent = new Agent(new Registry(), {
    workspace: "/tmp/git-credential-test",
    chat: async messages => {
      providerInput = JSON.stringify(messages);
      return "Authentication was rejected.";
    },
  });
  agent._pendingGitPush = { command: "git push origin main" };
  const events = [];
  for await (const event of agent.loop(`token: ${token}`)) events.push(event);
  const visible = events
    .filter(event => event.type === "stream")
    .map(event => event.token)
    .join("");
  assert.equal(visible, "Authentication was rejected.");
  assert.equal(providerInput.includes(token), false);
  assert.equal(events.some(event => JSON.stringify(event).includes(token)), false);
});

test("global redaction masks common credential forms", () => {
  const text = `token: ${token} Bearer abcdefghijklmnopqrstuvwxyz password=hunter2`;
  const safe = redactSecrets(text);
  assert.doesNotMatch(safe, new RegExp(token));
  assert.doesNotMatch(safe, /abcdefghijklmnopqrstuvwxyz|hunter2/);
  assert.match(safe, /\[REDACTED\]/);
});
