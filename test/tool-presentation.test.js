import assert from "node:assert/strict";
import test from "node:test";
import {
  presentTool,
  setLatestToolExpanded,
  TOOL_ACCENTS,
  TOOL_STATE_COLORS,
} from "../ui/tool-presentation.js";
import { THEMES } from "../ui/theme.js";

test("tool presentation uses semantic theme roles", () => {
  assert.ok(new Set(Object.values(TOOL_ACCENTS)).size >= 6);
  assert.notEqual(TOOL_ACCENTS.web, TOOL_ACCENTS.websearch);
  assert.notEqual(TOOL_ACCENTS.read, TOOL_ACCENTS.write);
  for (const role of [...Object.values(TOOL_ACCENTS), ...Object.values(TOOL_STATE_COLORS)]) {
    assert.ok(role in THEMES.dark, `missing dark token ${role}`);
    assert.ok(role in THEMES.light, `missing light token ${role}`);
    assert.equal(THEMES.mono[role], undefined);
  }
});

test("theme keeps assistant content brighter than tool evidence", () => {
  assert.notEqual(THEMES.dark.assistant, THEMES.dark.toolResult);
  assert.notEqual(THEMES.dark.toolResult, THEMES.dark.metadata);
  assert.notEqual(THEMES.light.assistant, THEMES.light.toolResult);
});

test("tool presentation exposes text labels and states without decorative icons", () => {
  const running = presentTool({ tool: "web", args: { url: "https://example.com" }, done: false });
  const success = presentTool({ tool: "read", args: { path: "/tmp/file.js" }, content: "File: /tmp/file.js\nLines: 2\none\ntwo", done: true, duration: 618 });
  const warning = presentTool({ tool: "bash", args: { command: "npm start" }, content: "Warning: redirected", done: true });
  const failed = presentTool({ tool: "bash", args: { command: "node missing.js" }, content: "Exit: 2\nError: module not found", done: true });
  const timedOut = presentTool({ tool: "task", content: "Tool timed out after 60000ms.", done: true });

  assert.deepEqual([running.label, running.state], ["Fetch", "running"]);
  assert.equal(running.accentRole, "toolRead");
  assert.equal(running.stateRole, "info");
  assert.deepEqual([success.label, success.state, success.statusLabel, success.duration], ["Read", "success", "completed", "618ms"]);
  assert.deepEqual([warning.label, warning.state], ["Shell", "warning"]);
  assert.deepEqual([failed.label, failed.state], ["Shell", "failed"]);
  assert.deepEqual([timedOut.label, timedOut.state], ["Think", "failed"]);
  assert.equal("icon" in running, false);
});

test("fetch metadata is condensed into content type, bytes, and character count", () => {
  const view = presentTool({
    tool: "web",
    args: { url: "https://shopee.co.id/" },
    done: true,
    content: "URL: https://shopee.co.id/\nContent-Type: text/html\nBytes: 187\nTotal 103 chars | showing 0-103\nPage title",
  });

  assert.equal(view.summary, "https://shopee.co.id/");
  assert.deepEqual(view.metadata, ["text/html", "187 B", "103 chars"]);
  assert.deepEqual(view.preview.lines, ["Page title"]);
});

test("shell summaries are concise while preserving commands as expandable details", () => {
  const view = presentTool({
    tool: "bash",
    args: { command: "rm -f /root/test/snake_game.py && ls -la /root/test" },
    content: "Exit: 0",
    done: true,
    duration: 441,
    resultSize: 107,
  });

  assert.equal(view.summary, "Deleted snake_game.py");
  assert.equal(view.statusLabel, "completed");
  assert.deepEqual(view.metadata, ["exit 0"]);
  assert.deepEqual(view.details, ["Command  rm -f /root/test/snake_game.py && ls -la /root/test"]);
});

test("shell presentation always exposes a redacted concise command preview", () => {
  const command = `API_KEY=secret-token npm test -- ${"very-long-filter ".repeat(10)}`;
  const view = presentTool({
    tool: "bash",
    args: { command },
    done: false,
  });
  assert.match(view.commandPreview, /npm test/);
  assert.doesNotMatch(view.commandPreview, /secret-token/);
  assert.equal(view.commandTruncated, true);
  assert.ok(view.commandPreview.length <= 96);
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

test("completed tools expose concise result previews from real output", () => {
  const cases = [
    {
      tool: "bash",
      args: { command: "npm test" },
      content: "Exit: 0\n# tests 24\n# pass 24\n# fail 0",
      expected: "24 tests passed, 0 failed",
    },
    {
      tool: "bash",
      args: { command: "npm run build" },
      content: "Exit: 0\nbundled output",
      expected: "Build completed successfully",
    },
    {
      tool: "read",
      args: { path: "session.js" },
      content: "File: session.js\nLines: 186\n1: source",
      expected: "Read 186 lines",
    },
    {
      tool: "grep",
      args: { pattern: "activeRunId" },
      content: "Found 3:\n/root/a.js:2: activeRunId\n/root/a.js:9: activeRunId\n/root/b.js:4: activeRunId",
      expected: "Found 3 matches in 2 files",
    },
    {
      tool: "write",
      args: { path: "session.js" },
      content: "Written 4915 bytes to session.js",
      expected: "Wrote 4.8 KB",
    },
    {
      tool: "edit",
      args: { path: "session.js" },
      content: "Edited session.js",
      expected: "Updated 1 matching section",
    },
  ];
  for (const entry of cases) {
    const view = presentTool({ ...entry, done: true });
    assert.deepEqual(view.resultPreview.lines, [entry.expected]);
  }
});

test("plan previews use structured status counts", () => {
  const view = presentTool({
    tool: "todowrite",
    done: true,
    content: "Updated 6 todos.",
    metadata: {
      todos: [
        { status: "completed" },
        { status: "completed" },
        { status: "completed" },
        { status: "in_progress" },
        { status: "pending" },
        { status: "pending" },
      ],
    },
  });
  assert.equal(view.label, "Plan updated");
  assert.deepEqual(view.resultPreview.lines, ["3 completed, 1 active, 2 pending"]);
});

test("result previews remove terminal controls, redact secrets, and stay bounded", () => {
  const view = presentTool({
    tool: "bash",
    args: { command: "deploy" },
    done: true,
    content: `Exit: 1\n\u001b[31mError: Authorization: Bearer ${"a".repeat(32)} password=secret-value ${"x".repeat(220)}\u001b[0m`,
  });
  const preview = view.resultPreview.lines.join("\n");
  assert.doesNotMatch(preview, /\u001b|secret-value|a{20}/);
  assert.match(preview, /\[REDACTED\]/);
  assert.ok(preview.length <= 160);
  assert.equal(view.resultPreview.lines.length, 1);
});

test("tool targets redact credentials before structured rendering", () => {
  const view = presentTool({
    tool: "webfetch",
    args: { url: "https://example.com/products?token=secret-value&item=1" },
    done: false,
  });
  assert.deepEqual(view.targets, [{
    label: "URL",
    value: "https://example.com/products?token=[REDACTED]&item=1",
  }]);
});

test("empty successful shell output has a useful fallback instead of exit metadata", () => {
  const view = presentTool({
    tool: "bash",
    args: { command: "mkdir src" },
    done: true,
    content: "Exit: 0",
  });
  assert.deepEqual(view.resultPreview.lines, ["Command completed with no output"]);
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
