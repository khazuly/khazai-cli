import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../app/agent.js";
import { Registry } from "../app/registry.js";
import { ExecutionPolicy } from "../app/execution-policy.js";
import { fallbackIntentContract } from "../app/intent-resolver.js";
import { redactSecrets, redactSerializable } from "../lib/secrets.js";
import { getProviderCredential } from "../lib/auth.js";
import { SecretStore } from "../app/secret-store.js";

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
  assert.equal(JSON.stringify(receivedMessages).includes(token), true);
  assert.equal(agent._messages.some(message => String(message.content).includes(token)), false);
  assert.match(agent._messages.findLast(message => message.role === "user").content, /\{\{secret:secret_\d+\}\}/);
  assert.equal(JSON.stringify(agent.exportSessionState()).includes(token), false);
});

test("credential-like input reaches the provider while echoed output stays redacted", async () => {
  const privateValue = "orchid-glass-9247";
  let providerInput = "";
  let buffered = "";
  let visible = "";
  const agent = new Agent(new Registry(), {
    workspace: "/tmp/git-credential-test",
    chat: async messages => {
      providerInput = JSON.stringify(messages);
      return `The credential ${privateValue} is valid.`;
    },
  });
  agent._pendingGitPush = { command: "git push origin main" };
  for await (const event of agent.loop(`credential: ${privateValue}`)) {
    if (event.type === "stream") buffered += event.token;
    if (event.type === "stream-end") visible = agent.redactForDisplay(buffered);
  }
  assert.equal(providerInput.includes(privateValue), true);
  assert.equal(visible, "The credential [REDACTED] is valid.");
  assert.equal(agent._messages.some(message => String(message.content).includes(privateValue)), false);
  assert.equal(JSON.stringify(agent.exportSessionState()).includes(privateValue), false);
  assert.equal(agent._secretStore.size, 0);
});

test("secret store resolves only the active scope and clears stale values", () => {
  const store = new SecretStore();
  const captured = store.capture(`Check API key ${token}`, "run-1", "turn-1");
  assert.match(captured.protectedContent, /\{\{secret:secret_1\}\}/);
  assert.equal(store.resolve(captured.protectedContent, "run-1", "turn-1").includes(token), true);
  assert.equal(store.resolve(captured.protectedContent, "run-2", "turn-2").includes(token), false);
  assert.equal(store.redact(`The key ${token} is valid.`), "The key [REDACTED] is valid.");
  assert.equal(store.rebind("run-2", "turn-2"), true);
  assert.equal(store.resolve(captured.protectedContent, "run-1", "turn-1").includes(token), false);
  assert.equal(store.resolve(captured.protectedContent, "run-2", "turn-2").includes(token), true);
  store.clear("run-2", "turn-2");
  assert.equal(store.size, 0);
});

test("cancellation clears secrets and recoverable provider state", () => {
  const agent = new Agent(new Registry(), { workspace: "/tmp/git-credential-test" });
  agent._secretStore.capture(`token: ${token}`, "run-cancel", "turn-cancel");
  agent._recoverableProviderRequest = { model: agent._model };
  agent.abort();
  assert.equal(agent._secretStore.size, 0);
  assert.equal(agent.hasRecoverableProviderRequest(), false);
});

test("tool arguments and results stay raw for the provider but protected in lifecycle state", async () => {
  const privateValue = "violet-river-7319";
  const registry = new Registry();
  registry.register({
    name: "echo_secret",
    description: "Echo a value",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    execute: args => `Tool returned ${args.value}`,
  });
  const providerContexts = [];
  const agent = new Agent(registry, {
    workspace: "/tmp/git-credential-test",
    chat: async messages => {
      providerContexts.push(JSON.stringify(messages));
      if (providerContexts.length === 1) {
        return JSON.stringify({ tool: "echo_secret", args: { value: privateValue } });
      }
      return `Verified ${privateValue}`;
    },
  });
  let buffered = "";
  let visible = "";
  const toolResults = [];
  for await (const event of agent.loop(`credential: ${privateValue}`)) {
    if (event.type === "tool-result") toolResults.push(event.result);
    if (event.type === "stream") buffered += event.token;
    if (event.type === "stream-end") visible = agent.redactForDisplay(buffered);
  }
  assert.equal(providerContexts.length, 2);
  assert.equal(providerContexts.every(context => context.includes(privateValue)), true);
  assert.equal(toolResults.some(result => result.includes(privateValue)), false);
  assert.equal(visible, "Verified [REDACTED]");
  assert.equal(JSON.stringify(agent.exportSessionState()).includes(privateValue), false);
  assert.match(JSON.stringify(agent._lifecycle.parts), /\{\{secret:secret_\d+\}\}/);
});

test("global redaction masks common credential forms", () => {
  const text = `token: ${token} Bearer abcdefghijklmnopqrstuvwxyz password=hunter2`;
  const safe = redactSecrets(text);
  assert.doesNotMatch(safe, new RegExp(token));
  assert.doesNotMatch(safe, /abcdefghijklmnopqrstuvwxyz|hunter2/);
  assert.match(safe, /\[REDACTED\]/);
});

test("structured redaction preserves strings containing escaped source quotes", () => {
  const value = {
    output: 'const token = "ghp_123456789012345678901234567890123456";',
  };

  const safe = redactSerializable(value);
  assert.equal(typeof safe.output, "string");
  assert.doesNotMatch(JSON.stringify(safe), /ghp_123456789012345678901234567890123456/);
  assert.match(safe.output, /\[REDACTED\]/);
});

test("provider credentials do not depend on a Kilo CLI installation", () => {
  assert.equal(getProviderCredential("auto-free", "KILO_API_KEY", "/tmp/khazai-missing-auth.json"), "");
});
