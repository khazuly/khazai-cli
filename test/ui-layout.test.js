import assert from "node:assert/strict";
import test from "node:test";
import { Readable, Writable } from "node:stream";
import { createElement as h } from "react";
import { Box, Static, render } from "ink";
import { Banner } from "../ui/components/banner.js";
import { EmptyState } from "../ui/components/empty-state.js";
import { MessageList } from "../ui/components/message-list.js";
import { SessionFooter } from "../ui/components/session-footer.js";
import { PlanList } from "../ui/components/plan-list.js";

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
    "Contents of `/tmp/test-khazai`:",
    "",
    "1. obfuscator.py (19 lines)",
    "   - Python script for obfuscating .py and .js files",
    "  - Uses base64 encoding",
    "   - Functions: obfuscate_file() and obfuscate_directory()",
    "",
    "2. test.py (21 lines)",
    "   - Script for encrypting JavaScript source files securely with AES-256 (CBC mode)",
    "   - Encrypts sample.js and saves the result to sample.enc",
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

test("PlanList renders one live panel without collapse controls", async () => {
  const plan = [
    { status: "completed", description: "Step 1" },
    { status: "active", description: "Step 2" },
    { status: "pending", description: "Step 3" },
  ];
  const frame = await renderComponent(h(PlanList, { plan }), 40, 30);
  assert.equal((frame.match(/Plan 1\/3/g) || []).length, 1, frame);
  assert.match(frame, /Step 1/);
  assert.match(frame, /Step 2/);
  assert.match(frame, /Step 3/);
  assert.doesNotMatch(frame, /Hide|Show/);
});

test("PlanList renders nothing without a Plan", async () => {
  const frame = await renderComponent(h(PlanList, { plan: [] }), 40, 30);
  assert.equal(frame.trim(), "");
});

test("completed Plan renders 10/10 with no live marker or collapse control", async () => {
  const plan = Array.from({ length: 10 }, (_, offset) => offset + 1).map(index => ({
    stepId: `plan-10:step-${index}`,
    description: `Step ${index}`,
    status: "completed",
  }));
  const frame = await renderComponent(h(PlanList, { plan }), 60, 30);
  assert.match(frame, /Plan 10\/10/);
  const markers = frame.split("\n").filter(line => /^\[[ ✓•×]\]/.test(line));
  assert.equal(markers.length, 10, frame);
  assert.ok(markers.every(line => line.startsWith("[✓]")), frame);
  assert.doesNotMatch(frame, /\[•\]/);
  assert.doesNotMatch(frame, /Hide|Show/);
});

test("narrow terminals keep one Plan heading and stable markers", async () => {
  const plan = [
    { status: "completed", description: "Read app/agent.js" },
    { status: "active", description: "Implement token masking utility" },
  ];
  for (const width of [16, 20, 26]) {
    const frame = await renderComponent(h(PlanList, { plan }), width, 30);
    assert.match(frame, /Plan 1\/2/);
    assert.equal((frame.match(/Plan 1\/2/g) || []).length, 1, frame);
    assert.doesNotMatch(frame, /Hide|Show/);
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
    "  Completed. The primary issue was in the Markdown parser and spinner state.",
    "",
    "  Changes:",
    "  - The parser is memoized to avoid running on every render.",
    "  - The spinner is isolated to avoid rerendering the conversation.",
    "  - Markdown width follows the terminal size.",
    "",
    "  Verification:",
    "  - Build passed.",
    "  - Alignment remains consistent on mobile terminals.",
    "  ---",
  ].join("\n");
  const frame = await renderComponent(h(MessageList, { messages: [{
    id: "final-response-layout",
    type: "answer",
    content,
  }] }), 40, 24);
  const lines = frame.split("\n").filter(line => line.trim());
  assert.ok(lines.some(line => line.startsWith("Completed.")), frame);
  assert.ok(lines.some(line => line.startsWith("Changes:")), frame);
  assert.ok(lines.some(line => line.startsWith("Verification:")), frame);
  assert.ok(lines.some(line => /^• The parser/.test(line)), frame);
  assert.doesNotMatch(frame, /─{8,}/);
  assert.ok(lines.every(line => line.trim().length !== 1), frame);
});
