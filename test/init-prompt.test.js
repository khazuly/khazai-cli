import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h } from "react";
import { render } from "ink";
import { InitPrompt } from "../ui/components/init-prompt.js";
import { stripAnsi, TerminalInput, TerminalOutput } from "./helpers/ink-render.js";

function latestFrame(stdout) {
  return stdout.frames
    .map(frame => stripAnsi(frame).replace(/\r/g, ""))
    .filter(frame => frame.trim())
    .at(-1) || "";
}

function mount(props) {
  const stdout = new TerminalOutput(64, 24);
  const stdin = new TerminalInput();
  const instance = render(h(InitPrompt, props), {
    stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  const settle = async () => { await new Promise(resolve => setTimeout(resolve, 80)); };
  const press = async key => {
    stdin.push(key);
    await new Promise(resolve => setTimeout(resolve, 80));
  };
  return { stdout, settle, press, unmount: () => instance.unmount() };
}

const BASE_PROPS = {
  mode: "create",
  workspaceRoot: "/tmp/demo",
  inspectedCount: 14,
  sectionCount: 6,
  wordCount: 927,
  previewContent: "# Project Overview\n\nDemo content.",
  proposedContent: "# Project Overview\n\nDemo content.",
  warnings: [],
  error: "",
  onWrite() {},
  onUpdate() {},
  onReplace() {},
  onRegenerate() {},
  onCustomInstruction() {},
  onBasic() {},
  onChangeModel() {},
  onCancel() {},
};

test("create mode shows preview details and recommended write option", async () => {
  const { stdout, unmount } = mount(BASE_PROPS);
  await new Promise(resolve => setTimeout(resolve, 45));
  const frame = latestFrame(stdout);
  assert.match(frame, /AGENTS\.md Preview/);
  assert.match(frame, /\/tmp\/demo/);
  assert.match(frame, /Inspected\s+14 files/);
  assert.match(frame, /Length\s+927 words/);
  assert.match(frame, /› Write AGENTS\.md \(Recommended\)/);
  assert.match(frame, /Generate basic template without AI/);
  assert.match(frame, /Cancel/);
  unmount();
});

test("enter confirms the selected write option", async () => {
  let written = false;
  const { settle, press, unmount } = mount({ ...BASE_PROPS, onWrite: () => { written = true; } });
  await settle();
  await press("\r");
  assert.equal(written, true);
  unmount();
});

test("escape cancels without writing", async () => {
  let cancelled = false;
  const { settle, press, unmount } = mount({ ...BASE_PROPS, onCancel: () => { cancelled = true; } });
  await settle();
  await press("\u001b");
  assert.equal(cancelled, true);
  unmount();
});

test("update mode offers merge, replace, and diff options", async () => {
  const { stdout, unmount } = mount({
    ...BASE_PROPS,
    mode: "update",
    existingContent: "# Project Overview\n\nOld content.",
  });
  await new Promise(resolve => setTimeout(resolve, 45));
  const frame = latestFrame(stdout);
  assert.match(frame, /AGENTS\.md already exists/);
  assert.match(frame, /› Update while preserving custom rules \(Recommended\)/);
  assert.match(frame, /Replace the file/);
  assert.match(frame, /Review proposed diff/);
  unmount();
});

test("review proposed diff opens a scrollable diff and escape returns", async () => {
  const { stdout, settle, press, unmount } = mount({
    ...BASE_PROPS,
    mode: "update",
    existingContent: "# Project Overview\n\nOld content.",
    proposedContent: "# Project Overview\n\nNew content.",
  });
  await settle();
  await press("\u001b[B");
  await press("\u001b[B");
  await press("\r");
  let frame = latestFrame(stdout);
  assert.match(frame, /proposed diff/);
  assert.match(frame, /- Old content/);
  assert.match(frame, /\+\s*New content/);
  await press("\u001b");
  frame = latestFrame(stdout);
  assert.match(frame, /AGENTS\.md already exists/);
  unmount();
});

test("review full content opens the scrollable preview", async () => {
  const { stdout, settle, press, unmount } = mount(BASE_PROPS);
  await settle();
  await press("\u001b[B");
  await press("\r");
  assert.match(latestFrame(stdout), /full content/);
  assert.match(latestFrame(stdout), /Demo content/);
  unmount();
});

test("replace confirmation defaults to cancel", async () => {
  let replaced = false;
  let cancelled = false;
  const { stdout, settle, press, unmount } = mount({
    ...BASE_PROPS,
    mode: "replaceConfirm",
    onReplace: () => { replaced = true; },
    onCancel: () => { cancelled = true; },
  });
  await settle();
  assert.match(latestFrame(stdout), /Replace entire AGENTS\.md\?/);
  await press("\r");
  assert.equal(cancelled, true);
  assert.equal(replaced, false);
  unmount();
});

test("replace confirmation can be confirmed explicitly with a second selection", async () => {
  let replaced = false;
  const { settle, press, unmount } = mount({
    ...BASE_PROPS,
    mode: "replaceConfirm",
    onReplace: () => { replaced = true; },
    onCancel() {},
  });
  await settle();
  await press("\u001b[B");
  await press("\r");
  assert.equal(replaced, true);
  unmount();
});

test("failed mode shows the concise error and retry options", async () => {
  const { stdout, unmount } = mount({
    ...BASE_PROPS,
    mode: "failed",
    error: "The model response was not structured JSON or Markdown.",
  });
  await new Promise(resolve => setTimeout(resolve, 45));
  const frame = latestFrame(stdout);
  assert.match(frame, /\[×\] Generated AGENTS\.md could not be prepared\./);
  assert.match(frame, /› Retry generation/);
  assert.match(frame, /Change model/);
  unmount();
});

test("warnings are displayed in the preview", async () => {
  const { stdout, unmount } = mount({
    ...BASE_PROPS,
    warnings: ["`npm run build` was not observed in package.json scripts."],
  });
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.match(latestFrame(stdout), /npm run build/);
  unmount();
});

test("failed mode retry regenerates instead of cancelling", async () => {
  let regenerated = false;
  let cancelled = false;
  const { settle, press, unmount } = mount({
    ...BASE_PROPS,
    mode: "failed",
    error: "The model response was not structured JSON or Markdown.",
    onRegenerate: () => { regenerated = true; },
    onCancel: () => { cancelled = true; },
  });
  await settle();
  await press("\r");
  assert.equal(regenerated, true);
  assert.equal(cancelled, false);
  unmount();
});

test("failed mode change model stays selectable and escape cancels without writing", async () => {
  let modelChanged = false;
  let written = false;
  let cancelled = false;
  const first = mount({
    ...BASE_PROPS,
    mode: "failed",
    error: "AGENTS.md generation timed out.",
    onWrite: () => { written = true; },
    onChangeModel: () => { modelChanged = true; },
  });
  await first.settle();
  await first.press("\u001b[B");
  await first.press("\r");
  assert.equal(modelChanged, true);
  assert.equal(written, false);
  first.unmount();

  const second = mount({
    ...BASE_PROPS,
    mode: "failed",
    error: "Generated AGENTS.md could not be prepared.",
    onWrite: () => { written = true; },
    onCancel: () => { cancelled = true; },
  });
  await second.settle();
  await second.press("\u001b");
  assert.equal(cancelled, true);
  assert.equal(written, false);
  second.unmount();
});

test("confirm triggers a single write even with repeated enter presses", async () => {
  let writes = 0;
  const { settle, press, unmount } = mount({ ...BASE_PROPS, onWrite: () => { writes++; } });
  await settle();
  await press("\r");
  await press("\r");
  await press("\r");
  assert.equal(writes, 1);
  unmount();
});
