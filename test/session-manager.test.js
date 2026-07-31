import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h } from "react";
import { render } from "ink";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../app/session-store.js";
import { COMMANDS } from "../ui/commands.js";
import { PromptInput } from "../ui/components/prompt-input.js";
import {
  formatSessionList,
  SessionManager,
  sessionManagerItems,
} from "../ui/components/session-manager.js";
import { stripAnsi, TerminalInput, TerminalOutput } from "./helpers/ink-render.js";

function latestFrame(stdout) {
  return stdout.frames
    .map(frame => stripAnsi(frame).replace(/\r/g, ""))
    .filter(frame => frame.trim())
    .at(-1) || "";
}

function savedSessions(count = 8) {
  return Array.from({ length: count }, (_, index) => ({
    id: `session-${index + 1}`,
    title: `Session ${index + 1}`,
    updatedAt: new Date(Date.now() - index * 60_000).toISOString(),
    messageCount: index + 1,
  }));
}

test("session manager scrolls beyond six rows and resumes the selected session", async () => {
  const stdout = new TerminalOutput(64, 24);
  const stdin = new TerminalInput();
  const resumed = [];
  const instance = render(h(SessionManager, {
    workspacePath: "/root/khazai-cli",
    sessions: savedSessions(),
    currentSessionId: "session-1",
    onResume: id => resumed.push(id),
    onDelete() {},
    onClear() {},
    onClose() {},
  }), {
    stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  const press = async key => {
    stdin.push(key);
    await new Promise(resolve => setTimeout(resolve, 45));
  };

  await new Promise(resolve => setTimeout(resolve, 45));
  assert.match(latestFrame(stdout), /Sessions · \/root\/khazai-cli/);
  assert.match(latestFrame(stdout), /Current/);
  for (let index = 0; index < 6; index++) await press("\u001b[B");
  assert.match(latestFrame(stdout), /2–7 of 9/);
  assert.match(latestFrame(stdout), /›Session 7|› Session 7/);
  await press("\r");
  assert.deepEqual(resumed, ["session-7"]);

  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});

test("session deletion requires confirmation and clear remains a separate manager action", async () => {
  const stdout = new TerminalOutput(64, 24);
  const stdin = new TerminalInput();
  const deleted = [];
  let cleared = 0;
  const instance = render(h(SessionManager, {
    workspacePath: "/workspace",
    sessions: savedSessions(2),
    currentSessionId: "session-1",
    onResume() {},
    onDelete: id => deleted.push(id),
    onClear: () => cleared++,
    onClose() {},
  }), {
    stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  const press = async key => {
    stdin.push(key);
    await new Promise(resolve => setTimeout(resolve, 45));
  };

  await new Promise(resolve => setTimeout(resolve, 45));
  await press("\u001b[3~");
  assert.match(latestFrame(stdout), /Remove session `Session 1`\?/);
  await press("\u001b[B");
  await press("\r");
  assert.deepEqual(deleted, ["session-1"]);
  assert.equal(cleared, 0);

  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});

test("session list formatting and store metadata are workspace scoped and sorted", () => {
  const root = mkdtempSync(join(tmpdir(), "khazai-session-manager-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const store = new SessionStore(workspace, join(root, "sessions"));
  const older = store.create({ title: "Older" });
  const newer = store.create({ title: "Newer" });
  older.updatedAt = "2026-01-01T00:00:00.000Z";
  store.save(older);
  newer.messages = [{ type: "user", content: "hello" }];
  store.save(newer);

  const sessions = store.list();
  assert.equal(sessions[0].id, newer.id);
  assert.equal(sessions[0].messageCount, 1);
  assert.match(formatSessionList(sessions, newer.id, workspace), /Newer · Current · 1 messages/);
  assert.equal(sessionManagerItems(sessions).at(-1).kind, "clear");
});

test("Enter executes canonical parent managers and Tab exposes their subcommands", async () => {
  const stdout = new TerminalOutput(54, 20);
  const stdin = new TerminalInput();
  const commands = [];
  const instance = render(h(PromptInput, {
    onSubmit() {},
    onCommand: (command, arg) => commands.push([command, arg]),
    commands: COMMANDS,
  }), {
    stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  stdin.push("/sessions");
  await new Promise(resolve => setTimeout(resolve, 80));
  stdin.push("\r");
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(commands, [["/sessions", ""]]);

  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});
