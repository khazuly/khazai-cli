import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h, Fragment } from "react";
import { Box, Static, Text, render } from "ink";
import { MessageList } from "../ui/components/message-list.js";
import { PromptInput } from "../ui/components/prompt-input.js";
import { StatusBar, formatElapsed } from "../ui/components/status-bar.js";
import { SessionFooter } from "../ui/components/session-footer.js";
import { COMMANDS } from "../ui/commands.js";
import { formatInteractiveQuestion, streamViewportText } from "../ui/session.js";
import { CLEAR_TERMINAL, NORMAL_SCROLL_MODE, prepareScrollableTerminal } from "../ui/scrollback-output.js";
import { renderComponent, stripAnsi, TerminalInput, TerminalOutput } from "./helpers/ink-render.js";

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

test("animated working state stays immediately above a visible disabled prompt", async () => {
  const stdout = new TerminalOutput(40, 14);
  const stdin = new TerminalInput();
  const instance = render(
    h(Box, { flexDirection: "column" },
      h(Text, null, "ACTIVE TOOL"),
      h(StatusBar, { running: true, plan: [] }),
      h(PromptInput, {
        onSubmit() {}, onCommand() {}, commands: [], disabled: true,
      }),
    ),
    { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false },
  );
  await new Promise(resolve => setTimeout(resolve, 100));
  const frames = stdout.frames.map(frame => stripAnsi(frame).replace(/\r/g, ""));
  const frame = frames.join("");
  assert.match(frame, /ACTIVE TOOL/);
  assert.match(frame, /Working/);
  assert.match(frame, /Working\.\.\./);
  const writesAfterInitialRender = stdout.frames.length;
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.ok(stdout.frames.length > writesAfterInitialRender, "Working animation must produce visible frames");
  assert.match(stripAnsi(stdout.frames.at(-1)), /Working\s+\d+s · Esc cancel/);

  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});

test("working duration switches to minutes after sixty seconds", () => {
  assert.equal(formatElapsed(36), "36s");
  assert.equal(formatElapsed(60), "1m 0s");
  assert.equal(formatElapsed(125), "2m 5s");
});

test("interactive question reuses the built-in CLI prompt without a second input", async () => {
  const frame = await renderComponent(h(SessionFooter, {
    running: true,
    plan: [],
    waitingForAnswer: true,
    promptProps: {
      onSubmit() {}, onCommand() {}, commands: [], disabled: false,
    },
  }), 40, 14);

  assert.match(frame, /❯ Ask anything\.\.\./);
  assert.doesNotMatch(frame, /^\s*>\s/gm);
  assert.doesNotMatch(frame, /Working/);
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
    questionOptions: ["Ya, hapus file ini", "Tidak, batalkan"],
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
  assert.match(output, /1\. Ya, hapus file ini/);
  assert.match(output, /2\. Tidak, batalkan/);
  assert.match(output, /↑↓ select · Enter confirm/);
  assert.deepEqual(selected, ["Tidak, batalkan"]);

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
  const prefix = "Hasil compile jelek: ";
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
  assert.match(stripAnsi(stdout.frames.join("")), /Hasil compile jelek: \[Pasted 240 chars\]/);
  stdin.push("\u001b[D");
  stdin.push("\u001b[C");
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.match(stripAnsi(stdout.frames.at(-1)), /Hasil compile jelek: \[Pasted 240 chars\]/);
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
  for (const character of "baris pertama\nbaris kedua ".repeat(12)) {
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
      "coba cek endpoint login facebook · auto-free · 3452283c",
      "coba cek file yang ada di folder ini · auto-free · ba133fbd",
    ],
    onSelectOption() {},
  }), 44, 14);

  assert.match(frame, /> 1\. coba cek endpoint login facebook/);
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
  const output = stripAnsi(stdout.frames.join("")).replace(/\r/g, "");

  assert.match(output, /Quick commands/);
  assert.match(output, /\/new\s+Start a persistent session/);
  assert.match(output, /\/model\s+Change the active model/);
  assert.doesNotMatch(output, /\/compact|\/connect|\/collapse/);
  assert.ok((output.match(/\n\s*[> ]?\s*\//g) || []).length <= 6);
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
      plan: [],
      waitingForAnswer: false,
      promptProps: {
        onSubmit() {}, onCommand() {}, commands: [], disabled: running,
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
  assert.match(latest, /Ask anything/);

  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});
