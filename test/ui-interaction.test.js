import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h, Fragment } from "react";
import { Box, Static, Text, render } from "ink";
import { MessageList } from "../ui/components/message-list.js";
import { PromptInput } from "../ui/components/prompt-input.js";
import { SessionFooter } from "../ui/components/session-footer.js";
import { COMMANDS } from "../ui/commands.js";
import { formatInteractiveQuestion, streamViewportText } from "../ui/session.js";
import { CLEAR_TERMINAL, NORMAL_SCROLL_MODE, prepareScrollableTerminal } from "../ui/scrollback-output.js";
import { renderComponent, stripAnsi, TerminalInput, TerminalOutput } from "./helpers/ink-render.js";

function latestTerminalFrame(stdout) {
  for (const frame of [...stdout.frames].reverse()) {
    const normalized = stripAnsi(frame).replace(/\r/g, "");
    if (normalized.trim()) return normalized;
  }
  return "";
}

test("completed responses accumulate in native terminal scrollback without truncation", async () => {
  const stdout = new TerminalOutput(40, 12);
  const stdin = new TerminalInput();
  const first = {
    id: "first-static-answer",
    type: "answer",
    content: "FIRST RESPONSE\nfirst response detail",
  };
  const second = {
    id: "second-static-answer",
    type: "answer",
    content: ["SECOND RESPONSE", ...Array.from({ length: 16 }, (_, index) => `full line ${index + 1}`)].join("\n"),
  };
  const view = items => h(Fragment, null,
    h(Static, { items }, item => h(MessageList, { key: item.id, messages: [item] })),
    h(Text, null, "LIVE PROMPT"),
  );
  const instance = render(view([first]), {
    stdout, stdin, debug: false, patchConsole: false, exitOnCtrlC: false,
  });
  await new Promise(resolve => setTimeout(resolve, 80));
  instance.rerender(view([first, second]));
  await new Promise(resolve => setTimeout(resolve, 100));

  const raw = stdout.frames.join("");
  const output = stripAnsi(raw);
  assert.equal((output.match(/FIRST RESPONSE/g) || []).length, 1, "completed messages must be committed once");
  assert.match(output, /SECOND RESPONSE/);
  assert.match(output, /full line 1\n/);
  assert.match(output, /full line 16/);
  assert.doesNotMatch(raw, /\u001b\[\?1049h|\u001b\[48;2;20;20;20m|\u001b\[3J/);

  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});

test("bounded dynamic output cannot trigger Ink's scrollback-clearing path", async () => {
  const stdout = new TerminalOutput(40, 8);
  const stdin = new TerminalInput();
  const content = count => streamViewportText(
    Array.from({ length: count }, (_, index) => `stream line ${index + 1}`).join("\n"),
    40,
    5,
  );
  const instance = render(h(Text, null, content(20)), {
    stdout, stdin, debug: false, patchConsole: false, exitOnCtrlC: false,
  });
  await new Promise(resolve => setTimeout(resolve, 80));
  instance.rerender(h(Text, null, content(24)));
  await new Promise(resolve => setTimeout(resolve, 100));
  const raw = stdout.frames.join("");
  assert.doesNotMatch(raw, /\u001b\[2J|\u001b\[3J|\u001b\[\?1049h/);
  assert.match(stripAnsi(raw), /stream line 24/);
  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});

test("interactive startup keeps native scrollback and avoids alternate screen", () => {
  const stdout = new TerminalOutput(40, 20);
  assert.equal(prepareScrollableTerminal(stdout), true);
  const raw = stdout.frames.join("");
  assert.equal(raw, NORMAL_SCROLL_MODE + CLEAR_TERMINAL);
  assert.match(raw, /\u001b\[\?1049l/);
  assert.doesNotMatch(raw, /\u001b\[\?1049h/);
});

test("read groups keep one live row and finalize without a file name", async () => {
  const running = await renderComponent(h(MessageList, { messages: [{
    id: "read-group-active",
    type: "read-group",
    count: 3,
    currentFile: "status-bar.js",
    done: false,
  }] }), 60, 12);
  assert.match(running, /Read 3 files · status-bar\.js/);
  assert.doesNotMatch(running, /\d+ms/);

  const completed = await renderComponent(h(MessageList, { messages: [{
    id: "read-group-finished",
    type: "read-group",
    count: 3,
    currentFile: "",
    done: true,
    duration: 287,
    failed: false,
    totalLines: 186,
  }] }), 60, 12);
  assert.match(completed, /\[✓\] Read 3 files · 287ms/);
  assert.doesNotMatch(completed, /status-bar\.js/);
});

test("read group markers remain intact at narrow widths", async () => {
  const active = await renderComponent(h(MessageList, { messages: [{
    id: "read-group-narrow-active",
    type: "read-group",
    count: 3,
    currentFile: "session.js",
    done: false,
    status: "running",
  }] }), 16, 12);
  assert.match(active, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+Read 3/);
  assert.doesNotMatch(active, /^\s*\]\s*$/m);

  const completed = await renderComponent(h(MessageList, { messages: [{
    id: "read-group-narrow-completed",
    type: "read-group",
    count: 1,
    currentFile: "",
    done: true,
    duration: 297,
    failed: false,
  }] }), 16, 12);
  assert.match(completed, /\[✓\] Read 1/);
  assert.doesNotMatch(completed, /^\s*\]\s*$/m);
  assert.doesNotMatch(completed, /\[✓Read/);
});

test("unknown tools render one concise failed row", async () => {
  const output = await renderComponent(h(MessageList, { messages: [{
    id: "unknown-tool-call",
    type: "tool",
    tool: "unknown_tool",
    args: { requestedTool: "shell_find" },
    content: JSON.stringify({
      code: "UNKNOWN_TOOL",
      requestedTool: "shell_find",
      availableTools: ["bash", "read"],
    }),
    done: true,
    failed: true,
    status: "error",
  }] }), 32, 8);
  assert.match(output, /\[×\] Unknown tool · shell_find/);
  assert.doesNotMatch(output, /pending|running|UNKNOWN_TOOL|availableTools/);
});

test("interactive question reuses the built-in CLI prompt without a second input", async () => {
  const frame = await renderComponent(h(SessionFooter, {
    running: true,
    waitingForAnswer: true,
    promptProps: {
      onSubmit() {}, onCommand() {}, commands: [], disabled: false,
    },
  }), 40, 14);

  assert.match(frame, /❯ Ask anything\.\.\./);
  assert.doesNotMatch(frame, /^\s*>\s/gm);
  assert.doesNotMatch(frame, /Working/, "Working must not appear when waiting for answer");

  assert.match(frame, /Waiting/);
  assert.ok(frame.indexOf("Waiting") < frame.indexOf("Ask anything..."),
    "waiting status should appear above the prompt");

  assert.match(frame, /Esc cancel/);
  assert.ok(frame.indexOf("Esc cancel") < frame.indexOf("Ask anything..."),
    "Esc cancel should appear above the prompt");
});

test("structured questions are formatted once above the built-in prompt", () => {
  assert.equal(
    formatInteractiveQuestion("What should I create?", ["Python file", "JavaScript file"]),
    "What should I create?\n1. Python file\n2. JavaScript file",
  );
});

test("interactive options use keyboard selection instead of free-text input", async () => {
  const stdout = new TerminalOutput(50, 14);
  const stdin = new TerminalInput();
  const selected = [];
  const instance = render(h(PromptInput, {
    onSubmit() {},
    onCommand() {},
    commands: [],
    disabled: false,
    questionOptions: ["Yes, delete this file", "No, cancel"],
    onSelectOption: option => selected.push(option),
  }), {
    stdout,
    stdin,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  await new Promise(resolve => setTimeout(resolve, 30));
  stdin.push("\u001b[B");
  await new Promise(resolve => setTimeout(resolve, 30));
  stdin.push("\r");
  await new Promise(resolve => setTimeout(resolve, 30));

  const output = stripAnsi(stdout.frames.join("")).replace(/\r/g, "");
  assert.match(output, /1\. Yes, delete this file/);
  assert.match(output, /2\. No, cancel/);
  assert.match(output, /↑↓ Select · PgUp\/PgDn · Enter Confirm/);
  assert.deepEqual(selected, ["No, cancel"]);

  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});

test("interactive option lists close with Escape", async () => {
  const stdout = new TerminalOutput(50, 14);
  const stdin = new TerminalInput();
  let cancelled = 0;
  const instance = render(h(PromptInput, {
    onSubmit() {}, onCommand() {}, commands: [], disabled: false,
    questionOptions: ["Session one", "Session two"],
    onCancelOption: () => { cancelled++; },
  }), {
    stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false,
  });

  await new Promise(resolve => setTimeout(resolve, 30));
  stdin.push("\u001b");
  await new Promise(resolve => setTimeout(resolve, 30));

  assert.equal(cancelled, 1);
  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});

test("long pasted prompts are compressed without changing submitted content", async () => {
  const stdout = new TerminalOutput(60, 18);
  const stdin = new TerminalInput();
  const submitted = [];
  const prefix = "The compile result is poor: ";
  const pasted = "x".repeat(240);
  const instance = render(h(PromptInput, {
    onSubmit: value => submitted.push(value), onCommand() {}, commands: [], disabled: false,
  }), {
    stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false,
  });

  await new Promise(resolve => setTimeout(resolve, 30));
  stdin.push(prefix);
  await new Promise(resolve => setTimeout(resolve, 150));
  stdin.push(pasted.slice(0, 80));
  await new Promise(resolve => setTimeout(resolve, 50));
  stdin.push(pasted.slice(80, 160));
  await new Promise(resolve => setTimeout(resolve, 50));
  stdin.push(pasted.slice(160));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.match(stripAnsi(stdout.frames.join("")), /The compile result is poor: \[Pasted 240 chars\]/);
  stdin.push("\u001b[D");
  stdin.push("\u001b[C");
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.match(stripAnsi(stdout.frames.at(-1)), /The compile result is poor: \[Pasted 240 chars\]/);
  stdin.push("\x7f");
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.doesNotMatch(stripAnsi(stdout.frames.at(-1)), /Pasted 240 chars/);
  stdin.push(pasted);
  await new Promise(resolve => setTimeout(resolve, 50));
  stdin.push("\r");
  await new Promise(resolve => setTimeout(resolve, 30));

  assert.deepEqual(submitted, [prefix + pasted]);
  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});

test("typed multiline prompts stay expanded", async () => {
  const stdout = new TerminalOutput(60, 18);
  const stdin = new TerminalInput();
  const instance = render(h(PromptInput, {
    onSubmit() {}, onCommand() {}, commands: [], disabled: false,
  }), {
    stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  for (const character of "first line\nsecond line ".repeat(12)) {
    stdin.push(character);
    await new Promise(resolve => setTimeout(resolve, 4));
  }
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.doesNotMatch(stripAnsi(stdout.frames.join("")), /\[Pasted \d+ chars\]/);
  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});

test("interactive session options stay on one terminal row", async () => {
  const frame = await renderComponent(h(PromptInput, {
    onSubmit() {},
    onCommand() {},
    commands: [],
    disabled: false,
    questionOptions: [
      "inspect the Facebook login endpoint · auto-free · 3452283c",
      "inspect the files in this folder · auto-free · ba133fbd",
    ],
    onSelectOption() {},
  }), 44, 14);

  assert.match(frame, /> 1\. inspect the Facebook login endpoint/);
  assert.doesNotMatch(frame, /3452283c/);
  for (const line of frame.split("\n")) {
    assert.ok(line.length <= 44, `session option exceeds terminal width: ${line}`);
  }
});

test("command palette stays compact while searching commands", async () => {
  const stdout = new TerminalOutput(40, 24);
  const stdin = new TerminalInput();
  const instance = render(h(PromptInput, {
    onSubmit() {}, onCommand() {}, commands: COMMANDS, disabled: false,
  }), {
    stdout,
    stdin,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  await new Promise(resolve => setTimeout(resolve, 30));
  stdin.push("/");
  await new Promise(resolve => setTimeout(resolve, 80));
  const output = latestTerminalFrame(stdout);

  assert.match(output, /Commands · 1–6 of \d+/);
  assert.match(output, /\/new\s+Start a new session/);
  assert.match(output, /\/model\s+Select the active model/);
  assert.doesNotMatch(output, /\/redo|\/compact|\/connect|\/collapse/);
  assert.ok((output.match(/\n\s*[›> ]?\s*\//g) || []).length <= 6);
  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});

test("command palette keeps keyboard navigation inside its scrolling viewport", async () => {
  const stdout = new TerminalOutput(46, 24);
  const stdin = new TerminalInput();
  const executed = [];
  const commands = Array.from({ length: 9 }, (_, index) => ({
    name: `/x${index + 1}`,
    description: `Command ${index + 1}`,
  }));
  const instance = render(h(PromptInput, {
    onSubmit() {},
    onCommand(command) { executed.push(command); },
    commands,
    disabled: false,
  }), {
    stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false,
  });

  const press = async key => {
    stdin.push(key);
    await new Promise(resolve => setTimeout(resolve, 80));
  };

  await press("/x");
  assert.match(latestTerminalFrame(stdout), /Commands · 1–6 of 9[\s\S]*› \/x1/);
  for (let index = 0; index < 6; index++) await press("\u001b[B");
  assert.match(latestTerminalFrame(stdout), /Commands · 2–7 of 9[\s\S]*› \/x7/);
  assert.doesNotMatch(latestTerminalFrame(stdout), /\/x1\s/);

  for (let index = 0; index < 6; index++) await press("\u001b[A");
  assert.match(latestTerminalFrame(stdout), /Commands · 1–6 of 9[\s\S]*› \/x1/);
  await press("\u001b[6~");
  assert.match(latestTerminalFrame(stdout), /Commands · 2–7 of 9[\s\S]*› \/x7/);
  await press("\u001b[6~");
  assert.match(latestTerminalFrame(stdout), /Commands · 4–9 of 9[\s\S]*› \/x9/);
  await press("\u001b[5~");
  assert.match(latestTerminalFrame(stdout), /Commands · 3–8 of 9[\s\S]*› \/x3/);
  await press("\u001b[H");
  assert.match(latestTerminalFrame(stdout), /Commands · 1–6 of 9[\s\S]*› \/x1/);
  await press("\u001b[F");
  assert.match(latestTerminalFrame(stdout), /Commands · 4–9 of 9[\s\S]*› \/x9/);
  await press("\r");
  assert.deepEqual(executed, ["/x9"]);

  await press("/x");
  await press("\u001b[F");
  await press("1");
  const filteredFrame = latestTerminalFrame(stdout);
  assert.match(filteredFrame, /Commands[\s\S]*› \/x1/);
  assert.doesNotMatch(filteredFrame, / of 9|\/x2/);
  await press("\u001b");
  assert.doesNotMatch(latestTerminalFrame(stdout), /Commands|\/x1\s+Command 1/);

  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});

test("at file picker filters workspace files and inserts the selected path", async () => {
  const stdout = new TerminalOutput(50, 18);
  const stdin = new TerminalInput();
  let submitted = "";
  const instance = render(h(PromptInput, {
    onSubmit(value) { submitted = value; },
    onCommand() {},
    commands: [],
    disabled: false,
    fileItems: ["src/auth.js", "src/account.js", "README.md"],
  }), {
    stdout,
    stdin,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  await new Promise(resolve => setTimeout(resolve, 40));
  stdin.push("@auth");
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.match(stripAnsi(stdout.frames.join("")), /Files[\s\S]*src\/auth\.js/);
  stdin.push("\t");
  await new Promise(resolve => setTimeout(resolve, 50));
  stdin.push("\r");
  await new Promise(resolve => setTimeout(resolve, 50));

  assert.equal(submitted, "@src/auth.js");
  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});

test("working state is removed as soon as the agent becomes idle", async () => {
  const stdout = new TerminalOutput(40, 12);
  const stdin = new TerminalInput();
  const footer = running => h(Box, { flexDirection: "column" },
    h(Text, null, "RESULT"),
    h(SessionFooter, {
      running,
      waitingForAnswer: false,
      promptProps: {
        onSubmit() {}, onCommand() {}, commands: [], canAbort: running,
      },
    }),
  );
  const instance = render(footer(true), {
    stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  await new Promise(resolve => setTimeout(resolve, 60));
  instance.rerender(footer(false));
  await new Promise(resolve => setTimeout(resolve, 60));
  const latest = stdout.frames.map(frame => stripAnsi(frame).replace(/\r/g, "")).at(-1) || "";
  assert.doesNotMatch(latest, /Working/);
  assert.doesNotMatch(latest, /Esc cancel/, "Esc cancel must not appear in idle state");
  assert.match(latest, /Ask anything/);

  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});
