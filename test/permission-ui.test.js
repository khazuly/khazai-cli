import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h } from "react";
import { render } from "ink";
import { MessageList } from "../ui/components/message-list.js";
import { PermissionPrompt } from "../ui/components/permission-prompt.js";
import { PromptInput } from "../ui/components/prompt-input.js";
import { renderComponent, stripAnsi, TerminalInput, TerminalOutput } from "./helpers/ink-render.js";

const OPTIONS = ["Allow once", "Always allow this path", "Reject"];
const REQUEST = {
  action: "KhazAI wants to write outside the active workspace.",
  target: {
    label: "Path",
    value: "/root/tokopedia-fake-detector/src/tokopedia_detector/main.py",
  },
};

async function waitUntil(predicate, message) {
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

test("permission card keeps human-readable content aligned at narrow widths", async () => {
  const frame = await renderComponent(h(PermissionPrompt, {
    request: REQUEST,
    options: OPTIONS,
    selectedIndex: 0,
    width: 34,
  }), 36, 20);

  assert.match(frame, /Action required/);
  assert.match(frame, /KhazAI wants to write outside/);
  assert.match(frame, /Path:/);
  assert.match(frame, /tokopedia/);
  assert.match(frame, /detector/);
  assert.match(frame, /main\.py/);
  assert.match(frame, /› Allow once/);
  assert.match(frame, /Always allow this path/);
  assert.match(frame, /↑↓ Select · Enter Confirm/);
  assert.match(frame, /Esc Reject/);
  assert.doesNotMatch(frame, /external_directory|\{"path"/);
  for (const line of frame.split("\n")) {
    assert.ok(line.length <= 36, `permission row exceeds terminal width: ${line}`);
  }
});

test("shell action approval never renders an unverified path rule", async () => {
  const frame = await renderComponent(h(PermissionPrompt, {
    request: {
      action: "KhazAI wants to run an unclassified shell command.",
      target: { label: "Command", value: 'echo "/etc/passwd"' },
      evidence: {
        action: "shell",
        workspaceRoot: "/root/project",
        workingDirectory: "/root/project",
        filesystemTargets: ["/root/project"],
        externalTargets: [],
        reason: "Unclassified command: custom-command",
      },
    },
    options: ["Allow once", "Always allow this action", "Reject"],
    selectedIndex: 0,
    width: 44,
  }), 46, 18);
  assert.match(frame, /Command:/);
  assert.match(frame, /Always allow this action/);
  assert.doesNotMatch(frame, /Path:|Always allow this path/);
});

test("permission prompt supports arrows, numeric selection, and Escape rejection", async () => {
  const stdout = new TerminalOutput(50, 18);
  const stdin = new TerminalInput();
  const selected = [];
  let rejected = 0;
  const instance = render(h(PromptInput, {
    onSubmit() {},
    onCommand() {},
    commands: [],
    disabled: false,
    questionKind: "permission",
    permissionRequest: REQUEST,
    questionOptions: OPTIONS,
    onSelectOption: option => selected.push(option),
    onCancelOption: () => { rejected++; },
  }), {
    stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false,
  });

  await waitUntil(() => stdout.frames.length > 0, "Permission prompt did not render.");
  stdin.push("\u001b[B");
  await waitUntil(
    () => /› Always allow this path/.test(stripAnsi(stdout.frames.at(-1) || "")),
    "Arrow Down did not select the second permission option.",
  );
  stdin.push("\r");
  await waitUntil(() => selected.length === 1, "Enter did not confirm the selected permission option.");
  stdin.push("3");
  await waitUntil(() => selected.length === 2, "Numeric selection did not confirm the third permission option.");
  stdin.push("\u001b");
  await waitUntil(() => rejected === 1, "Escape did not reject the permission request.");

  assert.deepEqual(selected, ["Always allow this path", "Reject"]);
  assert.equal(rejected, 1);
  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});

test("pending permission tool row does not render as running", async () => {
  const frame = await renderComponent(h(MessageList, { messages: [{
    id: "pending-write",
    type: "tool",
    callId: "write-call",
    tool: "write",
    args: { path: "/root/project/main.py" },
    done: false,
    status: "awaiting-approval",
  }] }), 42, 10);

  assert.match(frame, /\[ \] Write · awaiting approval/);
  assert.doesNotMatch(frame, /Write · running|Running Write/);
});
