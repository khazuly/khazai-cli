import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../app/agent.js";
import { Registry } from "../app/registry.js";
import { SessionStore, migrateSessionV6 } from "../app/session-store.js";

function workspace() {
  return mkdtempSync(join(tmpdir(), "khazai-durable-resume-"));
}

test("an admitted run restores as interrupted with its original objective", () => {
  const root = workspace();
  try {
    const agent = new Agent(new Registry(), { workspace: root, chat: async () => "Done." });
    agent.admitRun("Implement durable session recovery", {
      runId: "run-1",
      turnId: "turn-1",
      taskEpoch: 7,
      mode: "build",
    });
    const resumed = new Agent(new Registry(), {
      workspace: root,
      chat: async () => "Done.",
      sessionState: agent.exportSessionState(),
    });
    assert.deepEqual(resumed.interruptedRun(), {
      ...agent.exportSessionState().activeRun,
      status: "interrupted",
    });
    assert.equal(resumed.interruptedRun().objective, "Implement durable session recovery");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resume preserves completed tools and terminally reconciles running tools", () => {
  const root = workspace();
  try {
    const state = {
      version: 6,
      sessionId: "session-1",
      messages: [],
      parts: [
        { id: "done", type: "tool", callId: "call-done", tool: "read", state: { status: "completed", output: "ok", time: { start: 1, end: 2 } } },
        { id: "running", type: "tool", callId: "call-running", tool: "bash", state: { status: "running", input: { command: "npm test" }, time: { start: 3 } } },
      ],
      activeRun: { status: "running", runId: "run-1", turnId: "turn-1", objective: "finish tests" },
    };
    const agent = new Agent(new Registry(), { workspace: root, sessionState: state, chat: async () => "Done." });
    assert.equal(agent._lifecycle.parts.find(part => part.id === "done").state.status, "completed");
    const interrupted = agent._lifecycle.parts.find(part => part.id === "running");
    assert.equal(interrupted.state.status, "error");
    assert.equal(interrupted.state.metadata.interrupted, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session v5 migration is idempotent and forks never auto-resume", () => {
  const root = workspace();
  const data = workspace();
  try {
    const migrated = migrateSessionV6({
      version: 5,
      id: "legacy",
      workspace: root,
      messages: [],
      turns: [],
      parts: [],
      runtime: { version: 3 },
      agentState: { activeRun: { status: "running", objective: "legacy task" } },
    });
    assert.equal(migrated.version, 6);
    assert.equal(migrated.runtime.version, 4);
    assert.equal(migrated.activeRun.objective, "legacy task");
    assert.equal(migrateSessionV6(migrated), migrated);

    const store = new SessionStore(root, data);
    const session = store.create();
    session.agentState = { activeRun: { status: "interrupted", objective: "do not fork" }, parts: [] };
    session.activeRun = session.agentState.activeRun;
    store.save(session);
    const fork = store.fork(session.id);
    assert.equal(fork.activeRun, null);
    assert.equal(fork.agentState.activeRun, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});
