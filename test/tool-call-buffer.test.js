import assert from "node:assert/strict";
import test from "node:test";
import { createToolCallBuffer, syntheticPartialToolCall } from "../lib/tool-call-buffer.js";

const scope = { requestId: "request-1", runId: "run-1", turnId: "turn-1", taskEpoch: 3 };

test("tool call buffer joins split tool names and fragmented arguments", () => {
  const buffer = createToolCallBuffer(scope);
  buffer.accept([{ index: 4, id: "call-write", function: { name: "Wr", arguments: "" } }]);
  buffer.accept([{ index: 4, function: { name: "ite", arguments: '{"path":"pycompiler.py","content":"print(' } }]);
  buffer.finish("stop");

  assert.deepEqual(buffer.incomplete(), {
    requestId: "request-1", runId: "run-1", turnId: "turn-1", taskEpoch: 3,
    toolCallId: "call-write", providerStreamIndex: 4, toolNameComplete: true,
    argumentsComplete: false, finishReason: "stop",
  });
});

test("tool call buffer accepts a complete fragmented call and omits user content from diagnostics", () => {
  const buffer = createToolCallBuffer(scope);
  buffer.accept([{ index: 0, id: "call-write", function: { name: "write", arguments: '{"path":"py' } }]);
  buffer.accept([{ index: 0, function: { arguments: 'compiler.py","content":"ok"}' } }]);
  buffer.finish("tool-calls");

  assert.equal(buffer.incomplete(), null);
  const partial = syntheticPartialToolCall('{"tool":"write","args":{"path":"secret', scope);
  assert.equal(partial.argumentsComplete, false);
  assert.equal(Object.hasOwn(partial, "arguments"), false);
});
