import assert from "node:assert/strict";
import test from "node:test";
import { mergeToolCallDelta } from "../lib/llm.js";
import { bashTool } from "../tools/shell.js";

test("SSE tool-call fragments are assembled before parsing", () => {
  const calls = new Map();
  mergeToolCallDelta(calls, { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "wr" } }] });
  mergeToolCallDelta(calls, { tool_calls: [{ index: 0, function: { name: "ite", arguments: '{"path":"a.js",' } }] });
  mergeToolCallDelta(calls, { tool_calls: [{ index: 0, function: { arguments: '"content":"ok"}' } }] });
  assert.deepEqual([...calls.values()], [{
    id: "call_1",
    type: "function",
    function: { name: "write", arguments: '{"path":"a.js","content":"ok"}' },
  }]);
});

test("grep exit 1 without stderr is a successful no-match inspection", async () => {
  const result = await bashTool.execute({ command: "grep khazai_no_match_9f4b /dev/null", workdir: "/tmp" });
  assert.equal(result, "No matches found");
});
