import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement as h } from "react";
import { render } from "ink";
import { Agent } from "../app/agent.js";
import { Registry } from "../app/registry.js";
import { PromptInput } from "../ui/components/prompt-input.js";
import { SessionFooter } from "../ui/components/session-footer.js";
import {
  formatQueuedMessages,
  UserMessageQueue,
} from "../ui/user-message-queue.js";
import { stripAnsi, TerminalInput, TerminalOutput } from "./helpers/ink-render.js";

test("session queue preserves FIFO ownership and never starts an item twice", () => {
  const queue = new UserMessageQueue("session-1");
  const first = queue.enqueue("Message A", "Message A", 1);
  const second = queue.enqueue("Message B", "Message B", 2);

  assert.deepEqual(queue.pending().map(item => item.id), [first.id, second.id]);
  assert.equal(queue.startNext().id, first.id);
  assert.equal(queue.startNext(), null);
  assert.equal(queue.markRunning(first.id), true);
  assert.equal(queue.markRunning(first.id), false);
  assert.equal(queue.complete(first.id), true);
  assert.equal(queue.startNext().id, second.id);
  assert.equal(queue.markRunning(second.id), true);
  assert.equal(queue.complete(second.id), true);
  assert.equal(queue.pendingCount(), 0);
});

test("queue clear removes only pending messages and keeps the running item", () => {
  const queue = new UserMessageQueue("session-1");
  const active = queue.enqueue("Active", "Active");
  queue.enqueue("secret", "[REDACTED]");
  queue.startNext();
  queue.markRunning(active.id);

  const display = formatQueuedMessages(queue.pending());
  assert.match(display, /\[REDACTED\]/);
  assert.doesNotMatch(display, /secret/);
  assert.equal(queue.clearPending(), 1);
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0].id, active.id);
  assert.match(formatQueuedMessages([]), /No messages are queued/);
});

test("cancelling an active queued turn preserves later pending messages", () => {
  const queue = new UserMessageQueue("session-1");
  const active = queue.enqueue("Message A", "Message A");
  const pending = queue.enqueue("Message B", "Message B");
  queue.startNext();
  queue.markRunning(active.id);

  assert.equal(queue.cancel(active.id), true);
  assert.deepEqual(queue.pending().map(item => item.id), [pending.id]);
  assert.equal(queue.startNext().id, pending.id);
});

test("editable tool prompt submits text, shows queue feedback, and keeps Escape cancellation", async () => {
  const stdout = new TerminalOutput(48, 14);
  const stdin = new TerminalInput();
  const submitted = [];
  let aborted = 0;
  const instance = render(h(SessionFooter, {
    running: false,
    plan: [],
    queueCount: 2,
    activeTool: { type: "tool", tool: "bash", status: "running" },
    promptProps: {
      onSubmit: value => submitted.push(value),
      onCommand() {},
      onAbort: () => { aborted++; },
      commands: [],
      disabled: false,
      canAbort: true,
    },
  }), {
    stdout,
    stdin,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  await new Promise(resolve => setTimeout(resolve, 30));
  stdin.push("Message A");
  await new Promise(resolve => setTimeout(resolve, 70));
  stdin.push("\r");
  await new Promise(resolve => setTimeout(resolve, 40));
  stdin.push("\u001b");
  await new Promise(resolve => setTimeout(resolve, 40));

  assert.deepEqual(submitted, ["Message A"]);
  assert.equal(aborted, 1);
  assert.match(stripAnsi(stdout.frames.join("")), /Queued · 2 messages pending/);
  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});

test("prompt draft and keyboard ownership survive working rerenders and a modal", async () => {
  const stdout = new TerminalOutput(54, 16);
  const stdin = new TerminalInput();
  const submitted = [];
  let cancelledModal = 0;
  const props = {
    onSubmit: value => submitted.push(value),
    onCommand() {},
    onAbort() {},
    commands: [],
    inputActive: true,
    activeModel: "big-cock",
  };
  const view = questionOptions => h(PromptInput, {
    ...props,
    canAbort: true,
    questionOptions,
    onSelectOption() {},
    onCancelOption: () => { cancelledModal++; },
  });
  const instance = render(view([]), {
    stdout,
    stdin,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  stdin.push("draft");
  await new Promise(resolve => setTimeout(resolve, 70));
  instance.rerender(view([]));
  stdin.push(" while working");
  await new Promise(resolve => setTimeout(resolve, 70));
  instance.rerender(view(["Allow", "Reject"]));
  await new Promise(resolve => setTimeout(resolve, 30));
  stdin.push("\u001b");
  await new Promise(resolve => setTimeout(resolve, 30));
  instance.rerender(view([]));
  await new Promise(resolve => setTimeout(resolve, 30));
  stdin.push("\r");
  await new Promise(resolve => setTimeout(resolve, 40));

  assert.equal(cancelledModal, 1);
  assert.deepEqual(submitted, ["draft while working"]);
  assert.match(stripAnsi(stdout.frames.at(-1) || ""), /Ask anything/);
  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});

test("tool boundary records the first result before a queued handoff stops the batch", async () => {
  const registry = new Registry();
  const executed = [];
  for (const name of ["read", "glob"]) {
    registry.register({
      name,
      description: name,
      parameters: { type: "object", properties: {} },
      async execute() {
        executed.push(name);
        return name === "read" ? "source" : "Found 1:\na.js";
      },
    });
  }
  const agent = new Agent(registry, {
    workspace: mkdtempSync(join(tmpdir(), "khazai-fifo-handoff-")),
    autoApprove: true,
    chat: async () => JSON.stringify([
      { tool: "read", args: { path: "a.js" }, id: "read-first" },
      { tool: "glob", args: { pattern: "*" }, id: "glob-second" },
    ]),
  });
  const scope = { runId: "run-1", turnId: "turn-1", taskEpoch: 1 };
  const iterator = agent.loop("Inspect files", undefined, scope);
  let resultEvent;
  while (!resultEvent) {
    const next = await iterator.next();
    assert.equal(next.done, false);
    if (next.value.type === "tool-result") resultEvent = next.value;
  }

  const boundary = await iterator.next();
  assert.equal(boundary.value.type, "tool-call");
  assert.deepEqual(executed, ["read"]);
  assert.ok(agent._messages.some(message => (
    message.role === "tool"
    && message.tool_call_id === "read-first"
    && message.content === "source"
  )));
  agent.abort();
  await iterator.return();
  assert.deepEqual(executed, ["read"]);
});
