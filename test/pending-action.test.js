import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { Agent } from "../app/agent.js";
import { Registry } from "../app/registry.js";
import { fallbackIntentContract } from "../app/intent-resolver.js";

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

async function offeredFixAgent() {
  mkdirSync("/tmp/pending-action-test", { recursive: true });
  writeFileSync("/tmp/pending-action-test/paste.js", "function compress() { return input; }\n");
  const registry = new Registry();
  const edits = [];
  registry.register({ name: "read", description: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, async execute() { return "function compress() { return input; }"; } });
  registry.register({ name: "edit", description: "edit", parameters: { type: "object", properties: { path: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" } }, required: ["path", "oldString", "newString"] }, async execute(args) { edits.push(args); writeFileSync(args.path, readFileSync(args.path, "utf8").replace(args.oldString, args.newString)); return `Edited ${args.path}`; } });
  const agent = new Agent(registry, {
    workspace: "/tmp/pending-action-test",
    intentResolver: async ({ input }) => input.includes("jelaskan")
      ? { intent: "answer", category: "QUESTION", operation: "answer", requiredEvidence: [] }
      : fallbackIntentContract(input),
    chat: scripted([
      JSON.stringify({ tool: "read", args: { path: "paste.js" } }),
      "Masalah ada di paste compression. Mau saya fix dengan patch kecil?",
      JSON.stringify({ tool: "edit", args: { path: "paste.js", oldString: "return input", newString: "return compress(input)" } }),
      "Paste compression sudah diperbaiki.",
    ]),
  });
  return { agent, edits };
}

test("an offered fix is retained and an affirmative reply resumes the targeted modification", async () => {
  const { agent, edits } = await offeredFixAgent();
  await collect(agent, "cek bug paste compression di paste.js");

  assert.equal(agent._pendingAction?.status, "awaiting_confirmation");
  assert.equal(agent._pendingAction?.contract.category, "MODIFICATION");
  assert.deepEqual(agent._pendingAction?.targetFiles, ["paste.js"]);
  const events = await collect(agent, "iya");

  assert.equal(agent._taskContract.category, "MODIFICATION");
  assert.deepEqual(events.filter(event => event.type === "tool-call").map(event => event.tool), ["edit"]);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].path, "/tmp/pending-action-test/paste.js");
  assert.equal(agent._pendingAction, null);
});

for (const reply of ["lanjut", "oke", "gas", "fix"]) {
  test(`short reply ${reply} resumes the same pending action`, async () => {
    const { agent, edits } = await offeredFixAgent();
    await collect(agent, "cek bug paste compression di paste.js");
    await collect(agent, reply);
    assert.equal(edits.length, 1);
    assert.equal(agent._taskContract.category, "MODIFICATION");
  });
}

test("a substantive new request replaces an awaiting pending action", async () => {
  const agent = new Agent(new Registry(), {
    workspace: "/tmp/pending-replace-test",
    intentResolver: async () => ({ intent: "answer", category: "QUESTION", operation: "answer", requiredEvidence: [] }),
    chat: scripted(["Repository ini menggunakan ESM."]),
  });
  agent.restoreSessionState({
    currentRequest: "fix old.js",
    taskContract: fallbackIntentContract("fix old.js"),
    activeTask: { activeIntent: "MODIFICATION", goal: "fix old.js", targetFiles: ["old.js"], acceptanceCriteria: ["mutation"], evidenceNeeded: ["mutation"] },
    pendingAction: { status: "awaiting_confirmation", contract: fallbackIntentContract("fix old.js"), activeTask: { activeIntent: "MODIFICATION", goal: "fix old.js", targetFiles: ["old.js"], acceptanceCriteria: ["mutation"], evidenceNeeded: ["mutation"] }, goal: "fix old.js", nextStep: "edit old.js" },
  });

  await collect(agent, "jelaskan package.json");
  assert.equal(agent._taskContract.category, "QUESTION");
  assert.equal(agent._pendingAction, null);
});

test("an affirmative response without a pending action asks for a specific target", async () => {
  const agent = new Agent(new Registry(), { workspace: "/tmp/no-pending-action" });
  const events = await collect(agent, "iya");
  assert.match(events.find(event => event.type === "answer")?.content || "", /belum memiliki aksi tertunda/i);
});

test("pending action survives a session-state round trip without retaining credentials", () => {
  const original = new Agent(new Registry(), { workspace: "/tmp/pending-session" });
  const contract = fallbackIntentContract("fix paste.js");
  original._taskContract = contract;
  original._activeTask = { activeIntent: "MODIFICATION", goal: "fix paste.js", targetFiles: ["paste.js"], acceptanceCriteria: ["mutation"], evidenceNeeded: ["mutation"], nextExpectedAction: "patch paste.js" };
  original._pendingGitPush = { command: "git push origin main" };
  original._rememberPendingAction({ status: "awaiting_confirmation", offeredAction: "Fix paste.js", nextStep: "patch paste.js" });
  const restored = new Agent(new Registry(), { workspace: "/tmp/pending-session", sessionState: original.exportSessionState() });

  assert.equal(restored._pendingAction?.goal, "fix paste.js");
  assert.equal(restored._pendingAction?.contract.category, "MODIFICATION");
  assert.deepEqual(restored._pendingGitPush, { command: "git push origin main" });
  assert.doesNotMatch(JSON.stringify(restored.exportSessionState()), /ghp_|token|password/i);
});

test("a token continues a Git operation stored only in pending action state", async () => {
  const token = "ghp_123456789012345678901234567890123456";
  const agent = new Agent(new Registry(), { workspace: "/tmp/pending-git" });
  const contract = fallbackIntentContract("git push origin main");
  agent._taskContract = contract;
  agent._activeTask = { activeIntent: "GIT_OPERATION", goal: "git push origin main", targetFiles: [], acceptanceCriteria: ["git"], evidenceNeeded: ["git"], nextExpectedAction: "push origin main" };
  agent._rememberPendingAction({ status: "awaiting_credential", nextStep: "push origin main", gitPush: { command: "git push origin main" } });
  let used = "";
  agent._pushWithTemporaryCredential = async (_command, received) => {
    used = received;
    return { ok: true, result: "Exit: 0\nPush completed." };
  };

  const events = await collect(agent, `pakai token ini ${token}`);
  assert.equal(used, token);
  assert.equal(agent._pendingAction, null);
  assert.equal(events.some(event => JSON.stringify(event).includes(token)), false);
});
