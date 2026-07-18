import assert from "node:assert/strict";
import test from "node:test";
import { Readable, Writable } from "node:stream";
import { createElement as h, Fragment } from "react";
import { Box, Static, Text, render } from "ink";
import { Banner } from "../ui/components/banner.js";
import { EmptyState } from "../ui/components/empty-state.js";
import { MessageList } from "../ui/components/message-list.js";
import { PromptInput } from "../ui/components/prompt-input.js";
import { StatusBar } from "../ui/components/status-bar.js";
import { SessionFooter } from "../ui/components/session-footer.js";
import { ToolCall } from "../ui/components/tool-call.js";
import { CodePreview } from "../ui/components/code-preview.js";
import { ThemeProvider, resolveTheme } from "../ui/theme.js";
import { formatInteractiveQuestion } from "../ui/session.js";
import {
  CLEAR_TERMINAL,
  createScrollbackOutput,
  NORMAL_SCROLL_MODE,
  prepareScrollableTerminal,
} from "../ui/scrollback-output.js";

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

test("empty screen stays minimal and responsive from 30 to 50 columns", async () => {
  for (const columns of [30, 40, 50]) {
    const frame = await renderComponent(
      h(Box, { flexDirection: "column" },
        h(Banner, { model: "big-cock", workspace: "/tmp/test-khazai" }),
        h(EmptyState),
        h(PromptInput, { onSubmit() {}, onCommand() {}, commands: [], disabled: false }),
      ),
      columns,
    );
    assert.match(frame, /KhazAI · Big Cock/);
    assert.equal((frame.match(/Big Cock/g) || []).length, 1);
    assert.match(frame, /\/tmp\/test-khazai/);
    assert.match(frame, /Ready/);
    assert.match(frame, /Try/);
    assert.match(frame, /❯/);
    assert.match(frame, /Ask KhazAI\.\.\./);
    assert.match(frame.replace(/\s+/g, " "), /Enter send · .*Enter/);
    assert.match(frame, /[╭╮╰╯]/);
    assert.doesNotMatch(frame, /Type a message|v0\.3\.0/);
    assert.doesNotMatch(frame, /:: K H A Z A I ::|_\|\\_\\\|_\|/);
    assert.doesNotMatch(frame, /━{10,}/);
    // One external spacer plus the input panel's colored top padding keeps the
    // empty-state examples visually separate from the active prompt.
    assert.ok(maximumBlankRun(frame.trimEnd()) <= 2);
    assert.match(frame, /optimize this code[\s\S]*Message[\s\S]*❯/);
    const title = frame.split("\n").find(line => line.includes("KhazAI"));
    assert.equal(title.search(/\S/), 1);
    for (const line of frame.split("\n")) {
      assert.ok(line.length <= columns, `line exceeds ${columns} columns: ${line}`);
    }
  }
});

test("banner remains compact and left aligned through the real Static history", async () => {
  for (const columns of [40, 50]) {
    const item = { id: `banner-${columns}` };
    const frame = await renderComponent(
      h(Static, { items: [item] }, current => h(Banner, {
        key: current.id,
        model: "big-cock",
        workspace: "/tmp/test-khazai",
      })),
      columns,
    );
    for (const fragment of ["KhazAI", "/tmp/test-khazai"]) {
      const line = frame.split("\n").find(candidate => candidate.includes(fragment));
      assert.ok(line, `missing banner line containing ${fragment}`);
      const leading = line.search(/\S/);
      assert.equal(leading, 1, `${fragment} is not left aligned at ${columns} columns:\n${frame}`);
    }
  }
});

test("conversation hierarchy and tool metadata remain compact at mobile width", async () => {
  const frame = await renderComponent(h(MessageList, { messages: [
    { id: "u", type: "user", content: "Find the login endpoint for shopee.co.id." },
    { id: "a1", type: "answer", content: "I'll inspect the website." },
    {
      id: "t", type: "tool", tool: "web", done: true, duration: 618,
      args: { url: "https://shopee.co.id/buyer/login" },
      content: "URL: https://shopee.co.id/buyer/login\nContent-Type: text/html\nBytes: 187\nTotal 103 chars | showing 0-103",
    },
    { id: "a2", type: "streaming", content: "I found the login page." },
  ] }), 40, 24);

  assert.ok(frame.indexOf("You") < frame.indexOf("KhazAI"));
  assert.ok(frame.indexOf("KhazAI") < frame.indexOf("Shell"));
  assert.match(frame, /Shell\s+https:\/\/shopee\.co\.id\/buy…\s+618 ms/);
  assert.match(frame, /text\/html · 187 B · 103 chars/);
  assert.doesNotMatch(frame, /URL:|Content-Type:|Total chars:|[✓✗◌]/);
  assert.ok(maximumBlankRun(frame.trimEnd()) <= 2);
});

test("numbered and nested markdown lists keep consistent hanging indentation", async () => {
  const content = [
    "Isi folder `/tmp/test-khazai`:",
    "",
    "1. obfuscator.py (19 baris)",
    "   - Script Python untuk obfuscate file .py dan .js",
    "  - Menggunakan base64 encoding",
    "   - Fungsi: obfuscate_file() dan obfuscate_directory()",
    "",
    "2. test.py (21 baris)",
    "   - Script untuk encrypt file menggunakan AES-256 (CBC mode)",
    "   - Mengenkripsi sample.js dan menyimpan hasil ke sample.enc",
  ].join("\n");
  const frame = await renderComponent(h(MessageList, { messages: [
    { id: "formatted-list", type: "answer", content },
  ] }), 40, 30);
  const lines = frame.split("\n");
  const bullets = lines.filter(line => /^\s*•\s/.test(line));
  assert.ok(bullets.length >= 5, frame);
  assert.ok(bullets.every(line => line.indexOf("•") >= 0), `missing list markers:\n${bullets.join("\n")}`);
  const wrappedContinuation = lines.find(line => line.includes("(CBC mode)"));
  assert.ok(wrappedContinuation);
  assert.ok(wrappedContinuation.search(/\S/) >= 4, `wrapped list text lost hanging indent: ${wrappedContinuation}`);
  assert.ok(lines.some(line => line.startsWith("1. obfuscator.py")));
  assert.ok(lines.some(line => line.startsWith("2. test.py")));
});

test("assistant markdown renders quotes and responsive GFM tables", async () => {
  const content = [
    "> Important result",
    "",
    "| File | State |",
    "| --- | --- |",
    "| app.js | changed |",
  ].join("\n");
  const wide = await renderComponent(h(MessageList, { messages: [{ id: "md-wide", type: "answer", content }] }), 80, 20);
  const narrow = await renderComponent(h(MessageList, { messages: [{ id: "md-narrow", type: "answer", content }] }), 40, 20);
  assert.match(wide, /Important result/);
  assert.match(wide, /File\s+│\s+State/);
  assert.match(narrow, /File:\s+app\.js/);
  assert.match(narrow, /State:\s+changed/);
});

test("user panel keeps one external row before the first tool call", async () => {
  const frame = await renderComponent(h(MessageList, { messages: [
    { id: "user-gap", type: "user", content: "cek file" },
    {
      id: "tool-gap", type: "tool", tool: "bash", done: true, duration: 376,
      args: { command: "ls -la" }, content: "Exit: 0\nfile.py",
    },
  ] }), 40, 24);
  const lines = frame.split("\n");
  const contentLine = lines.findIndex(line => line.includes("cek file"));
  const toolLine = lines.findIndex(line => line.includes("Shell"));
  assert.equal(toolLine - contentLine, 2, "tool call must have one compact row after the user panel");
});

test("tool states use words and long output is collapsed", async () => {
  const output = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
  const frame = await renderComponent(h(Box, { flexDirection: "column" },
    h(ToolCall, { tool: "web", args: { url: "https://example.com" }, done: false }),
    h(ToolCall, { tool: "bash", args: { command: "npm test" }, done: true, content: `Exit: 0\n${output}` }),
    h(ToolCall, { tool: "bash", args: { command: "missing" }, done: true, content: "Exit: 2\nError: not found" }),
    h(ToolCall, { tool: "bash", args: { command: "npm start" }, done: true, content: "Warning: redirected" }),
  ), 50, 30);

  assert.doesNotMatch(frame, /running\.\.\./);
  assert.match(frame, /failed/);
  assert.match(frame, /warning/);
  assert.doesNotMatch(frame, /line 12/, "successful tool output stays collapsed");
  assert.match(frame, /Error: not found/);
  assert.doesNotMatch(frame, /[✓✗◌]/);
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
        content: "coba buatkan masing masing 1 contoh kode .py dan .js lalu tes enkripsi",
      }] }),
      h(PromptInput, { onSubmit() {}, onCommand() {}, commands: [], disabled: false }),
    )),
    { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false },
  );
  await new Promise(resolve => setTimeout(resolve, 60));
  stdin.push("tulis prompt panjang yang harus wrap dengan rapi");
  await new Promise(resolve => setTimeout(resolve, 80));

  const raw = stdout.frames.join("");
  assert.doesNotMatch(raw, /\u2800/, "Braille blank glyphs must never be used for panel padding");
  const rendered = stdout.frames
    .map(frame => stripAnsi(frame).replace(/\r/g, ""))
    .sort((left, right) => right.length - left.length)[0] || "";
  assert.match(rendered, /You/);
  assert.match(rendered, /coba buatkan masing masing/);
  assert.match(rendered, /tulis prompt panjang/);
  const lines = rendered.split("\n");
  const youLine = lines.findIndex(line => line.includes("You"));
  const userContentLine = lines.findIndex(line => line.includes("coba buatkan"));
  const promptLine = lines.findIndex(line => line.includes("tulis prompt"));
  assert.equal(userContentLine - youLine, 1, "You label and content should remain compact");
  assert.ok(lines[youLine].length < 40, "user label should not force a padded full-width background");
  assert.match(rendered, /[╭╮╰╯]/);
  for (const line of rendered.split("\n")) {
    assert.ok(line.length <= 40, `dark panel exceeds terminal width: ${line}`);
  }
  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});

test("write and edit tool results show GitHub Dark syntax previews", async () => {
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
  assert.match(frame, /Write\s+\/tmp\/demo\.py\s+·\s+python/);
  assert.match(frame, /def greet\(name\):/);
  assert.match(frame, /Edit\s+\/tmp\/config\.py\s+·\s+python/);
  assert.match(frame, /-value = 1/);
  assert.match(frame, /\+value = 2/);

  const stdout = new TerminalOutput(50, 20);
  const instance = render(
    h(CodePreview, { tool: "write", args: messages[0].args }),
    { stdout, debug: true, patchConsole: false, exitOnCtrlC: false },
  );
  await new Promise(resolve => setTimeout(resolve, 40));
  if (!process.env.NO_COLOR) {
    assert.match(stdout.frames.join(""), /\u001b\[48;2;13;17;23m/);
  }
  instance.unmount();
  instance.cleanup();
});

test("factual completion receipt shows files and validation records without model claims", async () => {
  const frame = await renderComponent(h(MessageList, { messages: [{
    id: "receipt",
    type: "summary",
    status: "finished",
    tools: 6,
    files: ["src/auth.js"],
    validations: [{ command: "npm test", exitCode: 0, duration: "1.2 s" }],
    duration: 2400,
  }] }), 50, 20);

  assert.match(frame, /Finished\s+6 tools · 2\.4 s/);
  assert.match(frame, /Files\s+src\/auth\.js/);
  assert.match(frame, /Check\s+npm test · exit 0 · 1\.2 s/);
  assert.doesNotMatch(frame, /created|updated|tests passed/i);
});

test("completion receipt truncates multiline validation commands", async () => {
  const command = `node --test ${"test/very-long-suite.test.js ".repeat(10)}
echo should-not-render-as-another-line`;
  const frame = await renderComponent(h(MessageList, { messages: [{
    id: "compact-receipt",
    type: "summary",
    status: "finished",
    tools: 2,
    files: ["src/auth.js"],
    validations: [{ command, exitCode: 0, duration: "1.2 s" }],
    duration: 2400,
  }] }), 60, 20);

  assert.match(frame, /Check\s+node --test/);
  assert.match(frame, /… · exit 0 · 1\.2 s/);
  assert.doesNotMatch(frame, /\necho should-not-render/);
});

test("theme resolver preserves semantics and honors NO_COLOR", () => {
  assert.equal(resolveTheme("dark", {}).name, "dark");
  assert.equal(resolveTheme("light", {}).panel, "#eef1f4");
  assert.equal(resolveTheme("dark", { NO_COLOR: "1" }).name, "mono");
});

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

test("long dynamic output cannot trigger Ink's scrollback-clearing path", async () => {
  const stdout = new TerminalOutput(40, 8);
  const inkOutput = createScrollbackOutput(stdout);
  const stdin = new TerminalInput();
  const content = count => Array.from({ length: count }, (_, index) => `stream line ${index + 1}`).join("\n");
  const instance = render(h(Text, null, content(20)), {
    stdout: inkOutput, stdin, debug: false, patchConsole: false, exitOnCtrlC: false,
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
  const frame = frames.findLast(value => value.includes("ACTIVE TOOL") && value.includes("Ask KhazAI")) || "";
  const lines = frame.split("\n");
  const activeLine = lines.findIndex(line => line.includes("ACTIVE TOOL"));
  const workingLine = lines.findIndex(line => line.includes("Working"));
  const promptLine = lines.findIndex(line => line.includes("Ask KhazAI"));
  assert.ok(activeLine >= 0);
  assert.ok(workingLine < promptLine, "Working must stay above the input panel");
  assert.ok(activeLine < workingLine);
  const writesAfterInitialRender = stdout.frames.length;
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.ok(stdout.frames.length > writesAfterInitialRender, "Working animation must produce visible frames");
  assert.match(stripAnsi(stdout.frames.at(-1)), /Working\s+\d+s · Esc cancel/);

  instance.unmount();
  instance.cleanup();
  stdin.destroy();
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

  assert.match(frame, /❯ Ask KhazAI\.\.\./);
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
  assert.match(latest, /Ask KhazAI/);

  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});
