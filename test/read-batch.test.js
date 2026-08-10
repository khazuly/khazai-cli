import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h, memo } from "react";
import { Box, Text, render } from "ink";
import {
  addReadToBatch, completeReadInBatch, createReadBatch, finishReadBatch,
} from "../ui/read-batch.js";
import { createSessionActivityController } from "../ui/session-activity-controller.js";
import { MessageList } from "../ui/components/message-list.js";
import { ReadGroupCall } from "../ui/components/tool-call.js";
import { TerminalInput, TerminalOutput, renderComponent, stripAnsi } from "./helpers/ink-render.js";

const scope = {
  runId: "run-1",
  turnId: "turn-1",
  taskEpoch: 2,
  workspacePath: "/workspace",
};

function batchWithReads() {
  let batch = createReadBatch(scope, 1, "read-1", { path: "lib/session.js" }, 100);
  batch = addReadToBatch(batch, "read-2", { path: "./lib/session.js" }, 120);
  return addReadToBatch(batch, "read-3", { path: "lib/context.js" }, 140);
}

function activityHarness() {
  const archived = [];
  const activeRef = { current: null };
  const activeScopeRef = { current: { ...scope } };
  const controller = createSessionActivityController({
    analysisScope: scope,
    analysisRef: { current: null },
    activeRef,
    activeScopeRef,
    appendArchived: message => archived.push(message),
    planRef: { current: { steps: [] } },
    workspacePath: scope.workspacePath,
    setActiveMessage() {},
    setPlanVisibility() {},
    planPanelAfterFinal: () => null,
    thinkActivityFromPlan: () => ({}),
  });
  return { activeRef, activeScopeRef, archived, controller };
}

test("read batches incrementally aggregate unique paths with a stable scoped identity", () => {
  let batch = batchWithReads();
  assert.equal(batch.batchId, "run-1:turn-1:2:1");
  assert.equal(batch.total, 2);
  assert.deepEqual(batch.uniquePaths, ["/workspace/lib/session.js", "/workspace/lib/context.js"]);

  batch = completeReadInBatch(batch, "read-1", false, 400);
  batch = completeReadInBatch(batch, "read-2", false, 500);
  batch = completeReadInBatch(batch, "read-3", false, 600);
  batch = finishReadBatch(batch, 700);

  assert.equal(batch.completed, 2);
  assert.equal(batch.failed, 0);
  assert.equal(batch.duration, 600);
  assert.equal(batch.entries.length, 3);
});

test("read batches preserve partial failures and expand without file content", async () => {
  let batch = createReadBatch(scope, 1, "read-1", { path: "lib/session.js" }, 100);
  batch = addReadToBatch(batch, "read-2", { path: "lib/context.js" }, 200);
  batch = completeReadInBatch(batch, "read-1", false, 1900);
  batch = completeReadInBatch(batch, "read-2", true, 1800);
  batch = finishReadBatch(batch, 2400);

  const collapsed = await renderComponent(h(MessageList, { messages: [batch] }), 60, 16);
  assert.match(collapsed, /\[!\] Read 1\/2 files\s+· 2\.3s/);
  assert.match(collapsed, /1 failed · \/expand/);
  assert.doesNotMatch(collapsed, /File:|source/);

  const expanded = await renderComponent(h(MessageList, {
    messages: [{ ...batch, id: "expanded-read-batch", expanded: true }],
  }), 60, 16);
  assert.match(expanded, /Read 2 files/);
  assert.match(expanded, /\[✓\] lib\/session\.js · 1\.8s/);
  assert.match(expanded, /\[!\] lib\/context\.js · 1\.6s/);

  const { archived, controller } = activityHarness();
  controller.startRead("read-failure", { path: "lib/context.js" }, 100);
  controller.recordReadResult("read-failure", "Error", true, 200);
  controller.finishReadBatch();
  assert.equal(archived[0].failed, 1);
});

test("a non-Read boundary and a new turn produce separate batches while stale results are ignored", () => {
  const { activeRef, activeScopeRef, archived, controller } = activityHarness();
  controller.startRead("read-1", { path: "lib/session.js" }, 100);
  controller.recordReadResult("read-1", "ok", false, 200);
  controller.finishReadBatch();
  controller.startRead("read-2", { path: "lib/context.js" }, 300);

  activeScopeRef.current = { ...scope, turnId: "turn-2" };
  controller.startRead("read-3", { path: "lib/llm.js" }, 400);
  const current = activeRef.current;
  controller.recordReadResult("read-2", "failed", true, 500);

  assert.equal(archived.length, 2);
  assert.notEqual(archived[0].batchId, archived[1].batchId);
  assert.equal(archived[1].callIds[0], "read-2");
  assert.equal(current.batchId, "run-1:turn-2:2:3");
  assert.equal(activeRef.current.completed, 0);
  assert.equal(activeRef.current.failed, 0);
});

test("Read batch timer updates do not rerender transcript, prompt, plan, or footer", async () => {
  const renders = { transcript: 0, prompt: 0, plan: 0, footer: 0 };
  const Transcript = memo(function Transcript() {
    renders.transcript++;
    return h(Text, null, "Transcript");
  });
  const Prompt = memo(function Prompt() {
    renders.prompt++;
    return h(Text, null, "Prompt");
  });
  const Plan = memo(function Plan() {
    renders.plan++;
    return h(Text, null, "Plan");
  });
  const Footer = memo(function Footer() {
    renders.footer++;
    return h(Text, null, "Footer");
  });
  const batch = createReadBatch(scope, 1, "read-1", { path: "lib/session.js" }, Date.now() - 1000);
  const stdout = new TerminalOutput(60, 16);
  const stdin = new TerminalInput();
  const instance = render(h(Box, { flexDirection: "column" },
    h(Transcript), h(ReadGroupCall, { batch }), h(Prompt), h(Plan), h(Footer),
  ), { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false });

  await new Promise(resolve => setTimeout(resolve, 260));
  assert.deepEqual(renders, { transcript: 1, prompt: 1, plan: 1, footer: 1 });
  assert.match(stripAnsi(stdout.frames.at(-1) || ""), /\[•\] Read 1 file/);

  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});
