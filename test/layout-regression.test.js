import assert from "node:assert/strict";
import test from "node:test";
import { Writable } from "node:stream";
import { createElement as h } from "react";
import { Box, Static, Text, render } from "ink";
import { MessageList } from "../ui/components/message-list.js";
import { normalizeVerticalWhitespace } from "../ui/text-layout.js";
import { normalizeStreamText, shouldShowCompletionSummary, streamViewportText } from "../ui/session.js";

class NarrowTerminal extends Writable {
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
}

function stripAnsi(text) {
  return text
    .replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "")
    .replace(/\u200b/g, "");
}

async function renderFrame(messages, columns, rows) {
  const stdout = new NarrowTerminal(columns, rows);
  const instance = render(h(MessageList, { messages }), {
    stdout,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await new Promise(resolve => setTimeout(resolve, 50));
  const rendered = stdout.frames
    .map(frame => stripAnsi(frame).replace(/\r/g, ""))
    .filter(frame => frame.trim());
  const frame = rendered.sort((left, right) => right.length - left.length)[0] || "";
  instance.unmount();
  instance.cleanup();
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

test("narrow terminal keeps consecutive tool blocks in normal vertical flow", async () => {
  const messages = [
    { id: "tool-fetch-1", type: "tool", tool: "web", args: { url: "https://example.com/a/very/long/path" }, done: true, content: "FETCH-FIRST\nContent-Type: text/html" },
    { id: "tool-search-1", type: "tool", tool: "websearch", args: { query: "a long search query that wraps" }, done: true, content: "SEARCH-MIDDLE\nTwo results" },
    { id: "tool-fetch-2", type: "tool", tool: "web", args: { url: "https://example.com/another/long/path" }, done: true, content: "FETCH-LAST\nContent-Type: text/html" },
    { id: "stream-answer", type: "streaming", content: "A long streaming response that wraps naturally in a narrow terminal without reserving the full viewport height." },
    { id: "error-result", type: "error", content: "Error: narrow fixture failure\nThe error details also wrap naturally." },
    { id: "task-summary", type: "summary", tools: 3, created: 0, updated: 0, tests: 0, duration: 1250 },
  ];

  for (const [columns, rows] of [[40, 20], [50, 30]]) {
    const frame = await renderFrame(messages, columns, rows);
    const first = frame.indexOf("https://example.com/a/very");
    const middle = frame.indexOf("a long search query");
    const last = frame.indexOf("https://example.com/another");
    assert.ok(first >= 0 && first < middle && middle < last, `tool order changed at ${columns} columns`);
    assert.ok(maximumBlankRun(frame.trimEnd()) <= 1, `more than one blank row rendered at ${columns} columns`);
    assert.ok(frame.split("\n").length < rows * 2, `message items reserved a viewport-sized block at ${columns} columns`);
  }
});

test("streaming chunks normalize carriage returns and repeated blank rows", () => {
  const chunks = ["\r\nFirst line", "\r\n  \r\n", "\r\n\r\nSecond line", "\n\n\nThird line"];
  let content = "";
  for (const chunk of chunks) content = normalizeVerticalWhitespace(content + chunk);

  assert.equal(content, "First line\n\nSecond line\n\nThird line");
  assert.ok(maximumBlankRun(content) <= 1);
});

test("streaming answer never adds a viewport-overflow cursor marker", async () => {
  const frame = await renderFrame([{
    id: "stream-without-overflow-marker",
    type: "streaming",
    content: "Implementasi Baileys dengan Pairing Code",
  }], 40, 20);

  assert.match(frame, /KhazAI/);
  assert.match(frame, /Implementasi Baileys/);
  assert.doesNotMatch(frame, /_\s*$/m);
  for (const line of frame.split("\n")) {
    assert.ok(line.length <= 40, `streaming row exceeds viewport width: ${line}`);
  }
});

test("streaming preview stays within the real viewport while retaining the full tail", () => {
  const complete = Array.from({ length: 20 }, (_, index) => `response line ${index + 1}`).join("\n");
  const preview = streamViewportText(complete, 40, 4);

  assert.equal(preview.split("\n").length, 4);
  assert.equal(preview.split("\n")[0], "…");
  assert.match(preview, /response line 20$/);
  assert.match(complete, /response line 1/);
  assert.doesNotMatch(preview, /response line 1(?:\n|$)/);
});

test("stream normalization preserves spaces across provider chunks", () => {
  const first = "Mau saya buat script";
  const second = " automation untuk login?";
  assert.equal(normalizeStreamText(first + second), "Mau saya buat script automation untuk login?");
});

test("completion summary is reserved for mutations and failures", () => {
  assert.equal(shouldShowCompletionSummary({ mutatedFiles: new Set(), failedTools: 0 }), false);
  assert.equal(shouldShowCompletionSummary({ mutatedFiles: new Set(["app.js"]), failedTools: 0 }), true);
  assert.equal(shouldShowCompletionSummary({ mutatedFiles: new Set(), failedTools: 1 }), true);
});

test("incremental static commits stay compact when tool labels wrap", async () => {
  const stdout = new NarrowTerminal(40, 20);
  const tools = [
    { id: "static-fetch", type: "tool", tool: "web", args: { url: "https://example.com/a/very/long/path" }, done: true, content: "STATIC-FIRST\nFetched body" },
    { id: "static-search", type: "tool", tool: "websearch", args: { query: "a query that wraps on Android" }, done: true, content: "STATIC-MIDDLE\nSearch body" },
    { id: "static-last", type: "tool", tool: "web", args: { url: "https://example.com/another/long/path" }, done: true, content: "STATIC-LAST\nFetched body" },
  ];
  const View = ({ items }) => h(Box, { flexDirection: "column", justifyContent: "flex-start" },
    h(Static, { items }, item => h(MessageList, { key: item.id, messages: [item] })),
    h(Text, {}, "PROMPT"),
  );
  const instance = render(h(View, { items: [] }), {
    stdout,
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
  });

  for (let count = 1; count <= tools.length; count++) {
    instance.rerender(h(View, { items: tools.slice(0, count) }));
    await new Promise(resolve => setTimeout(resolve, 60));
  }

  const commits = stdout.frames
    .map(frame => stripAnsi(frame).replace(/\r/g, ""))
    .filter(frame => /example\.com|query that wraps/.test(frame));
  instance.unmount();
  instance.cleanup();

  assert.equal(commits.length, 3);
  assert.match(commits[0], /example\.com\/a\/very/);
  assert.match(commits[1], /query that wraps/);
  assert.match(commits[2], /example\.com\/another/);
  for (const commit of commits) {
    assert.ok(maximumBlankRun(commit.trimEnd()) <= 1);
    assert.doesNotMatch(commit, /STATIC-/, "collapsed tools must not repeat result bodies");
    assert.ok(commit.split("\n").length < stdout.rows, "a static item reserved the terminal viewport");
  }
});
