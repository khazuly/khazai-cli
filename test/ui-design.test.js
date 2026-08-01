import assert from "node:assert/strict";
import test from "node:test";
import { Readable, Writable } from "node:stream";
import { createElement as h, Fragment } from "react";
import { Box, Static, Text, render } from "ink";
import { Banner } from "../ui/components/banner.js";
import { EmptyState } from "../ui/components/empty-state.js";
import { MessageList } from "../ui/components/message-list.js";
import { PromptInput } from "../ui/components/prompt-input.js";
import { SessionFooter } from "../ui/components/session-footer.js";
import { ToolCall } from "../ui/components/tool-call.js";
import { CodePreview } from "../ui/components/code-preview.js";
import { PlanList } from "../ui/components/plan-list.js";
import { COMMANDS } from "../ui/commands.js";
import { ThemeProvider, resolveTheme } from "../ui/theme.js";
import { formatInteractiveQuestion, streamViewportText } from "../ui/session.js";
import {
  CLEAR_TERMINAL,
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
        h(SessionFooter, {
          running: false,
          model: "big-cock",
          contextUsage: { usagePercent: 14 },
          promptProps: { onSubmit() {}, onCommand() {}, commands: [], disabled: false },
        }),
      ),
      columns,
    );
    assert.match(frame, /Khaz/);
    assert.match(frame, /Big/);
    assert.match(frame, /test-khaza/);
    assert.match(frame, /❯/);
    assert.match(frame, /Ask anything\.\.\./);
    assert.match(frame.replace(/\s+/g, " "), /Enter send/);
    assert.match(frame, /[╭╮╰╯]/);
    assert.doesNotMatch(frame, /Type a message|v0\.3\.0/);
    assert.doesNotMatch(frame, /:: K H A Z A I ::|_\|\\_\\\|_\|/);
    assert.doesNotMatch(frame, /━{10,}/);
    assert.ok(maximumBlankRun(frame.trimEnd()) <= 2);
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
    { id: "a2", type: "answer", content: "I found the login page." },
  ] }), 40, 24);

  assert.ok(frame.indexOf("You") < frame.indexOf("KhazAI"));
  assert.ok(frame.indexOf("KhazAI") < frame.indexOf("Fetch"));
  assert.match(frame, /Fetch · completed · 618ms/);
  assert.match(frame, /URL\s+https:\/\/shopee\.co\.id\/buye/);
  assert.match(frame, /Type\s+text\/html/);
  assert.match(frame, /Size\s+187 B · 103 chars/);
  assert.match(frame, /\/expand/);
  assert.match(frame, /Fetched 103 characters/);
  assert.doesNotMatch(frame, /URL:|Content-Type:|Total chars:/);
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

test("prefixed plan rows keep a fixed content column at narrow widths", async () => {
  const plan = [
    { status: "done", description: "Analyze rendering path" },
    { status: "running", description: "Implement alignment for every prefixed terminal row" },
    { status: "pending", description: "Verify a very long plan item that must wrap across several lines without changing its content column" },
    { status: "failed", description: "Run verification" },
  ];
  for (const width of [40, 60, 80]) {
    const frame = await renderComponent(h(PlanList, { plan }), width, 30);
    const lines = frame.split("\n").filter(Boolean);
    const markers = lines.filter(line => /^\[[ ✓•×]\]/.test(line));
    assert.equal(markers.length, 4, frame);
    assert.ok(markers.every(line => line.indexOf("] ") === 2), frame);
    const continuations = lines.filter(line => !/^\[[ ✓•×]\]/.test(line) && /prefixed terminal row|content column/.test(line));
    assert.ok(continuations.every(line => line.search(/\S/) === 4), frame);
  }
});

test("a long Plan title renders as one wrapped Plan item", async () => {
  const title = "session.js: finalize init generation exactly once at finish event, stop shimmer immediately";
  const plan = [{ status: "running", stepId: "step-2", description: title }];
  const frame = await renderComponent(h(PlanList, { plan }), 40, 30);
  const lines = frame.split("\n").filter(Boolean);
  const markers = lines.filter(line => /^\[[ ✓•×]\]/.test(line));
  assert.equal(markers.length, 1, frame);
  assert.match(markers[0], /^\[•\]/);
  const contentLines = lines.filter(line => !/^\[[ ✓•×]\]/.test(line) && !/^Plan \d/.test(line) && line.trim());
  assert.ok(contentLines.length >= 2, frame);
  assert.ok(contentLines.every(line => {
    const indent = line.search(/\S/);
    return indent >= 4 && indent <= 5;
  }), frame);
  const wrapped = [markers[0].replace(/^\[[ ✓•×]\]\s*/, ""), ...contentLines.map(line => line.trim())].join(" ");
  assert.ok(wrapped.startsWith("session.js: finalize init generation"), frame);
  assert.ok(wrapped.includes("stop shimmer immediately"), frame);
});

test("Plan titles never become React keys and full titles survive rendering", async () => {
  const title = "session.js: finalize init generation exactly once at finish event, stop shimmer immediately";
  const plan = [
    { status: "done", stepId: "step-1", planId: "plan-1", description: "Fix parseInitResult: fenced and plain Markdown extraction" },
    { status: "running", stepId: "step-2", planId: "plan-1", description: title },
    { status: "pending", stepId: "step-3", planId: "plan-1", description: "Restructure finalizer and state transition" },
  ];
  const wide = await renderComponent(h(PlanList, { plan }), 100, 30);
  assert.ok(wide.includes(title), "the complete Plan title must remain visible at wide widths");
  const frame = await renderComponent(h(PlanList, { plan }), 100, 30);
  assert.equal((frame.match(/\[✓\]|\[•\]|\[ \]|\[×\]/g) || []).length, 3, frame);
  assert.equal(frame.match(new RegExp(title.split(/\s+/).slice(0, 4).join("\\s+"), "g"))?.length, 1, frame);
});

test("terminal resize never duplicates Plan rows or splits markers", async () => {
  const plan = [
    { status: "done", description: "Read app/agent.js" },
    { status: "running", stepId: "s2", description: "Implement token masking utility" },
    { status: "pending", description: "Add intent resolver logic" },
  ];
  for (const width of [30, 40, 60, 80]) {
    const frame = await renderComponent(h(PlanList, { plan }), width, 30);
    const lines = frame.split("\n").filter(Boolean);
    const markers = lines.filter(line => /^\[[ ✓•×]\]/.test(line));
    assert.equal(markers.length, 3, `${width}: ${frame}`);
    assert.ok(markers.every(line => line.startsWith("[") && line.indexOf("]") === 2), `${width}: ${frame}`);
  }
});

test("collapsed PlanList hides rows while the heading and toggle stay visible", async () => {
  const plan = [
    { status: "completed", description: "Step 1" },
    { status: "active", description: "Step 2" },
    { status: "pending", description: "Step 3" },
  ];
  const expanded = await renderComponent(h(PlanList, { plan }), 40, 30);
  assert.match(expanded, /Plan 1\/3/);
  assert.match(expanded, /\[− Hide\]/);
  assert.match(expanded, /\[✓\]/);
  const collapsed = await renderComponent(h(PlanList, { plan, collapsed: true }), 40, 30);
  assert.match(collapsed, /Plan 1\/3/);
  assert.match(collapsed, /\[[+] Show\]/);
  assert.doesNotMatch(collapsed, /\[✓\]/);
  assert.doesNotMatch(collapsed, /Step 1/);
  assert.doesNotMatch(collapsed, /\[•\]/);
});

test("PlanList renders no heading or toggle without a Plan", async () => {
  const frame = await renderComponent(h(PlanList, { plan: [] }), 40, 30);
  assert.equal(frame.trim(), "");
});

test("completed Plan renders 7/7 with no live marker and no currentStepId dependency", async () => {
  const plan = [1, 2, 3, 4, 5, 6, 7].map(index => ({
    stepId: `plan-7:step-${index}`,
    description: `Step ${index}`,
    status: "completed",
  }));
  const frame = await renderComponent(h(PlanList, { plan }), 60, 30);
  assert.match(frame, /Plan 7\/7/);
  const markers = frame.split("\n").filter(line => /^\[[ ✓•×]\]/.test(line));
  assert.equal(markers.length, 7, frame);
  assert.ok(markers.every(line => line.startsWith("[✓]")), frame);
  assert.doesNotMatch(frame, /\[•\]/);
  assert.match(frame, /\[− Hide\]/);
});

test("narrow terminals wrap the Plan toggle without splitting it", async () => {
  const plan = [
    { status: "completed", description: "Read app/agent.js" },
    { status: "active", description: "Implement token masking utility" },
  ];
  for (const width of [16, 20, 26]) {
    const frame = await renderComponent(h(PlanList, { plan }), width, 30);
    assert.match(frame, /Plan 1\/2/);
    assert.match(frame, /\[− Hide\]|\[[+] Show\]/);
    const lines = frame.split("\n").filter(Boolean);
    assert.ok(lines.every(line => line.length <= width), `${width}: ${frame}`);
  }
});

test("numbered lists reserve one content column for one and two digit markers", async () => {
  const content = [
    "1. First item with a long description that wraps onto another line.",
    "2. Second item.",
    "10. Tenth item with another long description that wraps onto another line.",
  ].join("\n");
  const frame = await renderComponent(h(MessageList, { messages: [{
    id: "numbered-list-columns",
    type: "answer",
    content,
  }] }), 40, 20);
  const lines = frame.split("\n");
  assert.ok(lines.some(line => /^1\.  First/.test(line)), frame);
  assert.ok(lines.some(line => /^10\. Tenth/.test(line)), frame);
  const continuations = lines.filter(line => !/^\d+\./.test(line) && /another line/.test(line));
  assert.ok(continuations.every(line => line.search(/\S/) === 4), frame);
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

test("final responses keep paragraphs and lists left aligned without rules", async () => {
  const content = [
    "  Selesai. Masalah utama ada pada markdown parser dan state spinner.",
    "",
    "  Perubahan:",
    "  - Parser dimemoisasi agar tidak berjalan pada setiap render.",
    "  - Spinner dipisahkan agar tidak merender ulang conversation.",
    "  - Lebar markdown mengikuti ukuran terminal.",
    "",
    "  Verifikasi:",
    "  - Build berhasil.",
    "  - Alignment konsisten pada terminal mobile.",
    "  ---",
  ].join("\n");
  const frame = await renderComponent(h(MessageList, { messages: [{
    id: "final-response-layout",
    type: "answer",
    content,
  }] }), 40, 24);
  const lines = frame.split("\n").filter(line => line.trim());
  assert.ok(lines.some(line => line.startsWith("Selesai.")), frame);
  assert.ok(lines.some(line => line.startsWith("Perubahan:")), frame);
  assert.ok(lines.some(line => line.startsWith("Verifikasi:")), frame);
  assert.ok(lines.some(line => /^• Parser/.test(line)), frame);
  assert.doesNotMatch(frame, /─{8,}/);
  assert.ok(lines.every(line => line.trim().length !== 1), frame);
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

test("Ctrl+P toggles the Plan without capturing typed prompts", async () => {
  const stdout = new TerminalOutput(40, 24);
  const stdin = new TerminalInput();
  let toggles = 0;
  let submitted = "";
  const instance = render(h(PromptInput, {
    onSubmit(value) { submitted = value; },
    onCommand() {},
    commands: [],
    disabled: false,
    onTogglePlan() { toggles += 1; },
  }), {
    stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  await new Promise(resolve => setTimeout(resolve, 60));
  stdin.push("\u0010"); // Ctrl+P
  await new Promise(resolve => setTimeout(resolve, 60));
  stdin.push("plan text");
  await new Promise(resolve => setTimeout(resolve, 60));
  stdin.push("\r");
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(toggles, 1);
  assert.equal(submitted, "plan text");
  instance.unmount();
  instance.cleanup();
  stdin.destroy();
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
    content: "Sedang menyiapkan contoh.\n\n```python\ndef token():\n",
  }] }), 50, 20);

  assert.doesNotMatch(frame, /KhazAI|Sedang menyiapkan contoh|def token/);
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

test("theme resolver preserves semantics and honors NO_COLOR", () => {
  assert.equal(resolveTheme("dark", {}).name, "dark");
  assert.equal(resolveTheme("light", {}).panel, "#e6e9ef");
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
  assert.match(output, /↑↓ Select · PgUp\/PgDn · Enter Confirm/);
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
  const output = stripAnsi(stdout.frames.at(-1) || "").replace(/\r/g, "");

  assert.match(output, /Commands · 1–6 of \d+/);
  assert.match(output, /\/new\s+Start a new session/);
  assert.match(output, /\/model\s+Select the active model/);
  assert.doesNotMatch(output, /\/redo|\/compact|\/connect|\/collapse/);
  assert.ok((output.match(/\n\s*[> ›]?\s*\//g) || []).length <= 6);
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
