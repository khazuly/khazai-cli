import assert from "node:assert/strict";
import test from "node:test";
import { Readable, Writable } from "node:stream";
import { createElement as h } from "react";
import { Box, render } from "ink";
import { MessageList } from "../ui/components/message-list.js";
import { PromptInput } from "../ui/components/prompt-input.js";
import { ToolCall } from "../ui/components/tool-call.js";
import { CodePreview } from "../ui/components/code-preview.js";
import { ThemeProvider } from "../ui/theme.js";

class TerminalOutput extends Writable {
  constructor(columns, rows) {
    super();
    this.columns = columns;
    this.rows = rows;
    this.isTTY = true;
    this.frames = [];
  }
  _write(chunk, _encoding, callback) {
    this.frames.push(String(chunk));
    callback();
  }
  getColorDepth() { return 24; }
  hasColors() { return true; }
}

class TerminalInput extends Readable {
  constructor() {
    super();
    this.isTTY = true;
    this.isRaw = false;
  }
  _read() {}
  setRawMode(value) { this.isRaw = value; }
  ref() {}
  unref() {}
}

function stripAnsi(text) {
  return text
    .replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "")
    .replace(/[\u200b\u2800]/g, match => match === "\u2800" ? " " : "");
}

async function renderComponent(component, columns = 40, rows = 24) {
  const stdout = new TerminalOutput(columns, rows);
  const stdin = new TerminalInput();
  const instance = render(component, {
    stdout,
    stdin,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await new Promise(resolve => setTimeout(resolve, 40));
  const frames = stdout.frames.map(frame => stripAnsi(frame).replace(/\r/g, "")).filter(frame => frame.trim());
  const frame = frames.sort((left, right) => right.length - left.length)[0] || "";
  instance.unmount();
  instance.cleanup();
  stdin.destroy();
  return frame;
}

function maximumBlankRun(text) {
  let current = 0;
  let maximum = 0;
  for (const line of text.split("\n")) {
    current = line.trim() ? 0 : current + 1;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

test("user panel keeps one external row before the first tool call", async () => {
  const frame = await renderComponent(h(MessageList, { messages: [
    { id: "user-gap", type: "user", content: "inspect files" },
    {
      id: "tool-gap", type: "tool", tool: "bash", done: true, duration: 376,
      args: { command: "ls -la" }, content: "Exit: 0\nfile.py",
    },
  ] }), 40, 24);
  const lines = frame.split("\n");
  const contentLine = lines.findIndex(line => line.includes("inspect files"));
  const toolLine = lines.findIndex(line => line.includes("Shell"));
  assert.equal(toolLine - contentLine, 2, "tool call must have one compact row after the user panel");
});

test("tool states use words and long output is collapsed", async () => {
  const output = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
  const frame = await renderComponent(h(Box, { flexDirection: "column" },
    h(ToolCall, { tool: "web", args: { url: "https://example.com" }, done: false }),
    h(ToolCall, { tool: "bash", args: { command: "npm run lint" }, done: false, status: "running", startedAt: Date.now() - 12_000 }),
    h(ToolCall, { tool: "bash", args: { command: "npm test" }, done: true, content: `Exit: 0\n${output}` }),
    h(ToolCall, { tool: "bash", args: { command: "npm test" }, done: true, duration: 60_000, content: "Exit: -1\nTimed out after 60000ms" }),
    h(ToolCall, { tool: "bash", args: { command: "missing" }, done: true, content: "Exit: 2\nError: not found" }),
    h(ToolCall, { tool: "bash", args: { command: "npm start" }, done: true, content: "Warning: redirected" }),
  ), 50, 30);

  assert.doesNotMatch(frame, /running\.\.\./);
  assert.match(frame, /Shell · running · 12s/);
  assert.match(frame, /Command npm run lint/);
  assert.match(frame, /\[×\] Shell · failed/);
  assert.match(frame, /Command missing/);
  assert.match(frame, /Command npm start/);
  assert.doesNotMatch(frame, /line 12/, "successful tool output stays collapsed");
  assert.match(frame, /Command produced 12 lines/);
  assert.match(frame, /Error\s+not found/);
  assert.match(frame, /\[✓\] Shell · completed/);
  assert.match(frame, /\[×\] Shell · failed · 60\.0s/);
  assert.match(frame, /Timed out while running the test\n.*suite/);
  const errorLine = frame.split("\n").find(line => line.includes("Timed out while running"));
  const continuation = frame.split("\n").find(line => line.trim() === "│             suite");
  assert.equal(errorLine.indexOf("Timed"), continuation.indexOf("suite"));
});

test("successful shell commands reveal raw details only when expanded", async () => {
  const props = {
    tool: "bash",
    args: { command: "rm -f /root/test/snake_game.py && ls -la /root/test" },
    done: true,
    duration: 441,
    resultSize: 107,
    content: "Exit: 0",
  };
  const collapsed = await renderComponent(h(ToolCall, props), 50, 20);
  const expanded = await renderComponent(h(ToolCall, { ...props, expanded: true }), 50, 20);

  assert.match(collapsed, /Shell · completed/);
  assert.match(collapsed, /Command rm -f \/root\/test\/snake_game\.py/);
  assert.match(collapsed, /Command completed with no output/);
  assert.doesNotMatch(collapsed, /exit 0/);
  assert.match(expanded, /Command\s+rm -f/);
});

test("input cursor uses terminal-native blink without periodic redraws", async () => {
  const stdout = new TerminalOutput(40, 24);
  const stdin = new TerminalInput();
  const instance = render(
    h(PromptInput, { onSubmit() {}, onCommand() {}, commands: [], disabled: false }),
    { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false },
  );
  await new Promise(resolve => setTimeout(resolve, 80));
  const writesAfterInitialRender = stdout.frames.length;
  const rawOutput = stdout.frames.join("");
  await new Promise(resolve => setTimeout(resolve, 650));

  assert.match(rawOutput, /\u001b\[5;7m/);
  assert.equal(stdout.frames.length, writesAfterInitialRender);

  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});

test("user messages use an accent rail and input uses a responsive bordered composer", async () => {
  const stdout = new TerminalOutput(40, 24);
  const stdin = new TerminalInput();
  const instance = render(
    h(ThemeProvider, { name: "dark" }, h(Box, { flexDirection: "column" },
      h(MessageList, { messages: [{
        id: "user-dark-panel",
        type: "user",
        content: "create one Python example and one JavaScript example, then test encryption",
      }] }),
      h(PromptInput, { onSubmit() {}, onCommand() {}, commands: [], disabled: false }),
    )),
    { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false },
  );
  await new Promise(resolve => setTimeout(resolve, 60));
  stdin.push("write a long prompt that should wrap cleanly");
  await new Promise(resolve => setTimeout(resolve, 80));

  const raw = stdout.frames.join("");
  assert.doesNotMatch(raw, /\u2800/, "Braille blank glyphs must never be used for panel padding");
  const rendered = stdout.frames
    .map(frame => stripAnsi(frame).replace(/\r/g, ""))
    .sort((left, right) => right.length - left.length)[0] || "";
  assert.match(rendered, /You/);
  assert.match(rendered, /create one Python example/);
  assert.match(rendered, /write a long prompt/);
  const lines = rendered.split("\n");
  const youLine = lines.findIndex(line => line.includes("You"));
  const userContentLine = lines.findIndex(line => line.includes("create one Python"));
  const promptLine = lines.findIndex(line => line.includes("write a long prompt"));
  assert.equal(userContentLine - youLine, 1, "You label and content should remain compact");
  assert.ok(lines[youLine].length < 40, "user label should not force a padded full-width background");
  assert.match(rendered, /[╭╮╰╯]/);
  const composerTop = lines.find(line => line.includes("╭"));
  assert.equal(composerTop.length, 39, "composer must reserve the final terminal column");
  for (const line of rendered.split("\n")) {
    assert.ok(line.length <= 40, `dark panel exceeds terminal width: ${line}`);
  }
  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});

test("write and edit tool results show terminal-native syntax previews", async () => {
  const messages = [
    {
      id: "write-preview", type: "tool", tool: "write", done: true,
      args: { path: "/tmp/demo.py", content: "def greet(name):\n    return f'Hello {name}'" },
      content: "Written 44 bytes to /tmp/demo.py",
    },
    {
      id: "edit-preview", type: "tool", tool: "edit", done: true,
      args: { path: "/tmp/config.py", oldString: "value = 1", newString: "value = 2" },
      content: "Edited /tmp/config.py (exact)",
    },
  ];
  const frame = await renderComponent(h(MessageList, { messages }), 50, 30);
  assert.match(frame, /demo\.py\s+·\s+python/);
  assert.match(frame, /1\s+def greet/);
  assert.match(frame, /def greet\(name\):/);
  assert.match(frame, /− value = 1/);
  assert.match(frame, /1 \+ value = 2/);
  assert.match(frame, /config\.py\s+·\s+python\s+·\s+\+1\s+−1/);
  assert.match(frame, /1\s+− value = 1/);
  assert.match(frame, /1\s+\+ value = 2/);
  assert.doesNotMatch(frame, /---|\+\+\+|@@/);

  const stdout = new TerminalOutput(50, 20);
  const instance = render(
    h(CodePreview, { tool: "write", args: messages[0].args }),
    { stdout, debug: true, patchConsole: false, exitOnCtrlC: false },
  );
  await new Promise(resolve => setTimeout(resolve, 40));
  instance.unmount();
  instance.cleanup();
});

test("syntax panels keep each code line on one terminal row", async () => {
  const content = 'const veryLongIdentifier = "abcdefghijklmnopqrstuvwxyz0123456789";';
  const frame = await renderComponent(h(CodePreview, {
    tool: "write",
    args: { path: "/tmp/example.js", content },
  }), 40, 20);

  assert.match(frame, /1\s+const veryLongIdentifier/);
  assert.doesNotMatch(frame, /1\s+1\s+const veryLongIdentifier/);
  assert.match(frame, /"abcdef…/);
  assert.equal(frame.split("\n").length, 2);
  for (const line of frame.split("\n")) {
    assert.ok(line.length <= 40, `code row exceeds terminal width: ${line}`);
  }
});

test("expanded edit previews include surrounding context", async () => {
  const args = {
    path: "/tmp/config.py",
    oldString: "first\nsecond\nvalue = 1\nfourth\nfifth",
    newString: "first\nsecond\nvalue = 2\nfourth\nfifth",
  };
  const compact = await renderComponent(h(CodePreview, { tool: "edit", args }), 60, 20);
  const expanded = await renderComponent(h(CodePreview, { tool: "edit", args, expanded: true }), 60, 20);

  assert.doesNotMatch(compact, /first|second|fourth|fifth/);
  assert.match(expanded, /first/);
  assert.match(expanded, /fifth/);
});

test("private streaming content is not rendered", async () => {
  const frame = await renderComponent(h(MessageList, { messages: [{
    id: "streaming-markdown",
    type: "streaming",
    content: "Preparing an example.\n\n```python\ndef token():\n",
  }] }), 50, 20);

  assert.doesNotMatch(frame, /KhazAI|Preparing an example|def token/);
});

test("successful completion summaries stay hidden", async () => {
  const frame = await renderComponent(h(MessageList, { messages: [{
    id: "receipt",
    type: "summary",
    status: "finished",
    tools: 6,
    files: ["src/auth.js"],
    validations: [{ command: "npm test", exitCode: 0, duration: "1.2 s" }],
    duration: 2400,
  }] }), 50, 20);

  assert.doesNotMatch(frame, /Finished|Files|Check|src\/auth\.js|npm test/);
});

test("issue summary renders only concise unresolved problems", async () => {
  const command = `node --test ${"test/very-long-suite.test.js ".repeat(10)}
echo should-not-render-as-another-line`;
  const frame = await renderComponent(h(MessageList, { messages: [{
    id: "compact-receipt",
    type: "summary",
    status: "attention",
    tools: 2,
    files: ["src/auth.js"],
    validations: [{ command, exitCode: 0, duration: "1.2 s" }],
    unresolvedIssues: [
      "Build failed: unresolved TypeScript error",
      "Required verification did not complete",
    ],
    duration: 2400,
  }] }), 60, 20);

  assert.match(frame, /Finished with issues/);
  assert.match(frame, /Build failed: unresolved TypeScript error/);
  assert.match(frame, /Required verification did not complete/);
  assert.doesNotMatch(frame, /src\/auth\.js|node --test|2 tools|2\.4 s/);
});
