import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../app/agent.js";
import { Registry } from "../app/registry.js";

function scripted(responses) {
  return async (_messages, options) => {
    const response = responses.shift();
    options.onToken?.(response);
    return response;
  };
}

async function collect(agent, input) {
  const events = [];
  for await (const event of agent.loop(input)) events.push(event);
  return events;
}

test("legacy pending state is discarded and a new request goes directly to the provider", async () => {
  let providerMessages = [];
  const agent = new Agent(new Registry(), {
    workspace: "/tmp/pending-replace-test",
    chat: async (messages, options) => {
      providerMessages = messages;
      const response = "Repository ini menggunakan ESM.";
      options.onToken?.(response);
      return response;
    },
  });
  agent.restoreSessionState({
    currentRequest: "fix old.js",
    taskContract: { category: "MODIFICATION" },
    activeTask: { activeIntent: "MODIFICATION", goal: "fix old.js", targetFiles: ["old.js"], acceptanceCriteria: ["mutation"], evidenceNeeded: ["mutation"] },
    pendingAction: { status: "awaiting_confirmation", goal: "fix old.js", nextStep: "edit old.js" },
  });

  await collect(agent, "jelaskan package.json");
  assert.equal(agent._pendingAction, null);
  assert.match(JSON.stringify(providerMessages), /jelaskan package\.json/);
  assert.doesNotMatch(JSON.stringify(providerMessages), /edit old\.js/);
});

test("an affirmative response without pending state is handled by the provider", async () => {
  const agent = new Agent(new Registry(), {
    workspace: "/tmp/no-pending-action",
    chat: scripted(["What would you like me to continue?"]),
  });
  const events = await collect(agent, "yes");
  const visible = events
    .filter(event => event.type === "stream")
    .map(event => event.token)
    .join("");
  assert.equal(visible, "What would you like me to continue?");
});

test("session-state export drops legacy steering and credential continuation fields", () => {
  const original = new Agent(new Registry(), { workspace: "/tmp/pending-session" });
  original._taskContract = { category: "MODIFICATION" };
  original._activeTask = { activeIntent: "MODIFICATION", goal: "fix paste.js", targetFiles: ["paste.js"], acceptanceCriteria: ["mutation"], evidenceNeeded: ["mutation"], nextExpectedAction: "patch paste.js" };
  original._pendingGitPush = { command: "git push origin main" };
  original._rememberPendingAction({ status: "awaiting_confirmation", offeredAction: "Fix paste.js", nextStep: "patch paste.js" });
  const exported = original.exportSessionState();
  const restored = new Agent(new Registry(), { workspace: "/tmp/pending-session", sessionState: exported });

  assert.equal(exported.version, 4);
  assert.equal("pendingAction" in exported, false);
  assert.equal("activeTask" in exported, false);
  assert.equal("taskContract" in exported, false);
  assert.equal("pendingGitPush" in exported, false);
  assert.equal(restored._pendingAction, null);
  assert.equal(restored._pendingGitPush, null);
});

test("a credential does not trigger a hidden pending Git operation", async () => {
  const token = "ghp_123456789012345678901234567890123456";
  const agent = new Agent(new Registry(), {
    workspace: "/tmp/pending-git",
    chat: scripted(["Configure authentication before pushing."]),
  });
  agent._taskContract = { category: "GIT_OPERATION" };
  agent._activeTask = { activeIntent: "GIT_OPERATION", goal: "git push origin main", targetFiles: [], acceptanceCriteria: ["git"], evidenceNeeded: ["git"], nextExpectedAction: "push origin main" };
  agent._rememberPendingAction({ status: "awaiting_credential", nextStep: "push origin main", gitPush: { command: "git push origin main" } });
  let used = "";
  agent._pushWithTemporaryCredential = async (_command, received) => {
    used = received;
    return { ok: true, result: "Exit: 0\nPush completed." };
  };

  const events = await collect(agent, `use this token ${token}`);
  assert.equal(used, "");
  assert.equal(agent._pendingAction, null);
  assert.equal(events.some(event => JSON.stringify(event).includes(token)), false);
});
