import assert from "node:assert/strict";
import test from "node:test";
import { Writable } from "node:stream";
import { createElement as h } from "react";
import { Box, Static, Text, render } from "ink";
import { MessageList } from "../ui/components/message-list.js";
import { normalizeVerticalWhitespace } from "../ui/text-layout.js";

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
    const first = frame.indexOf("FETCH-FIRST");
    const middle = frame.indexOf("SEARCH-MIDDLE");
    const last = frame.indexOf("FETCH-LAST");
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
    .filter(frame => /STATIC-(?:FIRST|MIDDLE|LAST)/.test(frame));
  instance.unmount();
  instance.cleanup();

  assert.equal(commits.length, 3);
  assert.match(commits[0], /STATIC-FIRST/);
  assert.match(commits[1], /STATIC-MIDDLE/);
  assert.match(commits[2], /STATIC-LAST/);
  for (const commit of commits) {
    assert.ok(maximumBlankRun(commit.trimEnd()) <= 1);
    assert.doesNotMatch(commit, /https?:\/\/[^\n]*STATIC-/, "wrapped label overlapped its tool result");
    assert.ok(commit.split("\n").length < stdout.rows, "a static item reserved the terminal viewport");
  }
});
