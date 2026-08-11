import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createTerminalTitle, workspaceTitle } from "../ui/terminal-title.js";

function createHarness(options = {}) {
  const writes = [];
  const processRef = new EventEmitter();
  processRef.env = { TERM: options.term || "xterm-256color" };
  const timers = [];
  const cleared = [];
  const title = createTerminalTitle({
    stdout: { isTTY: options.tty !== false, write: value => writes.push(value) },
    processRef,
    setIntervalFn: callback => { timers.push(callback); return callback; },
    clearIntervalFn: timer => cleared.push(timer),
    workspacePath: options.workspacePath,
    cwd: options.cwd || "/root/khazai-cli",
  });
  return { title, writes, timers, cleared, processRef };
}

const scope = { runId: "run-1", turnId: "turn-1", taskEpoch: 1 };

test("terminal title starts idle and animates one active run", () => {
  const { title, writes, timers, cleared } = createHarness({ workspacePath: "/root/khazai-cli" });
  assert.equal(writes.at(-1), "\u001b]0;khazai-cli\u0007");
  assert.equal(title.start(scope), true);
  assert.equal(writes.at(-1), "\u001b]0;⠋ khazai-cli\u0007");
  assert.equal(timers.length, 1);
  title.start(scope);
  assert.equal(timers.length, 1);
  timers[0]();
  assert.equal(writes.at(-1), "\u001b]0;⠙ khazai-cli\u0007");
  assert.equal(title.finish(scope), true);
  assert.equal(cleared.length, 1);
  assert.equal(writes.at(-1), "\u001b]0;khazai-cli\u0007");
});

test("terminal title pauses for interaction and ignores stale scopes", () => {
  const { title, timers } = createHarness({ workspacePath: "/root/khazai-cli" });
  const newer = { runId: "run-2", turnId: "turn-2", taskEpoch: 2 };
  title.start(scope);
  title.pause(scope);
  assert.equal(title.start(scope), true);
  title.start(newer);
  assert.equal(timers.length, 2);
  title.finish(newer);
  assert.equal(title.start(scope), false);
  assert.equal(title.start(newer), false);
});

test("terminal title restores on shutdown and leaves unsupported terminals untouched", () => {
  for (const event of ["SIGINT", "SIGTERM", "exit"]) {
    const active = createHarness({ workspacePath: "/root/khazai-cli" });
    active.title.start(scope);
    active.processRef.emit(event);
    assert.equal(active.writes.at(-1), "\u001b]0;khazai-cli\u0007");
    active.title.dispose();
  }
  const idle = createHarness({ tty: false, workspacePath: "/root/khazai-cli" });
  idle.title.start(scope);
  idle.processRef.emit("SIGTERM");
  assert.deepEqual(idle.writes, []);
  assert.equal(idle.timers.length, 0);
  const dumb = createHarness({ term: "dumb", workspacePath: "/root/khazai-cli" });
  dumb.title.start(scope);
  assert.deepEqual(dumb.writes, []);
  assert.equal(dumb.timers.length, 0);
});

test("terminal title follows the active workspace without restarting its spinner", () => {
  const { title, writes, timers } = createHarness({ workspacePath: "/root/pycompiler" });
  assert.equal(writes.at(-1), "\u001b]0;pycompiler\u0007");
  title.start(scope);
  assert.equal(writes.at(-1), "\u001b]0;⠋ pycompiler\u0007");
  assert.equal(title.setWorkspace("/root/spam-otp"), true);
  assert.equal(writes.at(-1), "\u001b]0;⠋ spam-otp\u0007");
  assert.equal(timers.length, 1);
  timers[0]();
  assert.equal(writes.at(-1), "\u001b]0;⠙ spam-otp\u0007");
  title.pause(scope);
  assert.equal(writes.at(-1), "\u001b]0;spam-otp\u0007");
  assert.equal(title.setWorkspace("/root/khazai-cli"), true);
  assert.equal(writes.at(-1), "\u001b]0;khazai-cli\u0007");
});

test("workspace title sanitizes names and uses safe fallbacks", () => {
  assert.equal(workspaceTitle("/root/spam-otp"), "spam-otp");
  assert.equal(workspaceTitle("/root/pycompiler"), "pycompiler");
  assert.equal(workspaceTitle("\u001b]0;bad\u0007", ""), "KhazAI");
});
