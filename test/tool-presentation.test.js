import assert from "node:assert/strict";
import test from "node:test";
import {
  presentTool,
  setLatestToolExpanded,
  TOOL_ACCENTS,
  TOOL_STATE_COLORS,
} from "../ui/tool-presentation.js";
import { PASTEL } from "../ui/palette.js";

test("tool palette is varied, muted, and avoids bright semantic colors", () => {
  assert.ok(new Set(Object.values(TOOL_ACCENTS)).size >= 8);
  assert.notEqual(TOOL_ACCENTS.web, TOOL_ACCENTS.websearch);
  assert.notEqual(TOOL_ACCENTS.write, TOOL_ACCENTS.edit);
  for (const color of [...Object.values(TOOL_ACCENTS), ...Object.values(TOOL_STATE_COLORS)]) {
    assert.match(color, /^#[0-9a-f]{6}$/i);
    assert.doesNotMatch(color, /^(?:#00ffff|#00ff00|#ffff00|#00bfff)$/i);
  }
});

test("tool evidence uses a lower-contrast tier than assistant answers", () => {
  assert.notEqual(PASTEL.assistant, PASTEL.toolResult);
  assert.notEqual(PASTEL.toolResult, PASTEL.metadata);
  assert.equal(PASTEL.assistant, "#c9d1d9");
  assert.equal(PASTEL.toolResult, "#929ba6");
  assert.equal(PASTEL.metadata, "#707985");
});

test("tool presentation exposes text labels and states without decorative icons", () => {
  const running = presentTool({ tool: "web", args: { url: "https://example.com" }, done: false });
  const success = presentTool({ tool: "read", args: { path: "/tmp/file.js" }, content: "File: /tmp/file.js\nLines: 2\none\ntwo", done: true, duration: 618 });
  const warning = presentTool({ tool: "bash", args: { command: "npm start" }, content: "Warning: redirected", done: true });
  const failed = presentTool({ tool: "bash", args: { command: "node missing.js" }, content: "Exit: 2\nError: module not found", done: true });

  assert.deepEqual([running.label, running.state], ["Shell", "running"]);
  assert.deepEqual([success.label, success.state, success.duration], ["Read", "success", "618 ms"]);
  assert.deepEqual([warning.label, warning.state], ["Shell", "warning"]);
  assert.deepEqual([failed.label, failed.state], ["Shell", "failed"]);
  assert.equal("icon" in running, false);
});

test("fetch metadata is condensed into content type, bytes, and character count", () => {
  const view = presentTool({
    tool: "web",
    args: { url: "https://shopee.co.id/" },
    done: true,
    content: "URL: https://shopee.co.id/\nContent-Type: text/html\nBytes: 187\nTotal 103 chars | showing 0-103\nPage title",
  });

  assert.equal(view.target, "https://shopee.co.id/");
  assert.deepEqual(view.metadata, ["text/html", "187 B", "103 chars"]);
  assert.deepEqual(view.preview.lines, ["Page title"]);
});

test("search preview defaults to three results and expands without losing long titles", () => {
  const content = [
    "Search results for: shopee.co.id login endpoint API",
    "Found 6; showing 5",
    "",
    ...Array.from({ length: 5 }, (_, index) => [
      `${index + 1}. A very long Shopee search title number ${index + 1} that wraps on a mobile terminal`,
      `   URL: https://example.com/${index + 1}`,
      "   Source: example.com",
      `   Result description ${index + 1}`,
      "",
    ]).flat(),
  ].join("\n");

  const collapsed = presentTool({ tool: "websearch", args: { query: "shopee.co.id login endpoint API" }, content, done: true });
  const expanded = presentTool({ tool: "websearch", args: { query: "shopee.co.id login endpoint API" }, content, done: true, expanded: true });

  assert.deepEqual(collapsed.metadata, ["6 results", "showing 5"]);
  assert.equal(collapsed.searchResults.items.length, 3);
  assert.equal(collapsed.searchResults.hidden, 2);
  assert.equal(expanded.searchResults.items.length, 5);
  assert.equal(expanded.searchResults.hidden, 0);
  assert.match(expanded.searchResults.items[4].title, /number 5/);
});

test("multiline shell output uses explicit hidden-line and hidden-character counts", () => {
  const lines = Array.from({ length: 12 }, (_, index) => `shell output line ${index + 1}`);
  lines[0] += " x".repeat(180);
  const content = `Exit: 0\n${lines.join("\n")}`;
  const collapsed = presentTool({ tool: "bash", args: { command: "npm test" }, content, done: true });
  const expanded = presentTool({ tool: "bash", args: { command: "npm test" }, content, done: true, expanded: true });

  assert.equal(collapsed.preview.lines.length, 3);
  assert.equal(collapsed.preview.hiddenLines, 9);
  assert.ok(collapsed.preview.hiddenChars > 0);
  assert.equal(expanded.preview.lines.length, 12);
  assert.equal(expanded.preview.hiddenLines, 0);
  assert.equal(expanded.preview.hiddenChars, 0);
});

test("expand and collapse update the existing latest tool row without duplication", () => {
  const messages = [
    { id: "user-1", type: "user", content: "test" },
    { id: "tool-1", type: "tool", expanded: false },
    { id: "answer-1", type: "answer", content: "done" },
  ];
  const expanded = setLatestToolExpanded(messages, true, 0);
  const collapsed = setLatestToolExpanded(expanded, false, 0);

  assert.equal(expanded.length, messages.length);
  assert.equal(expanded[1].id, "tool-1");
  assert.equal(expanded[1].expanded, true);
  assert.equal(collapsed[1].expanded, false);
  assert.strictEqual(setLatestToolExpanded(messages, true, 2), messages, "archived rows must remain immutable");
});
