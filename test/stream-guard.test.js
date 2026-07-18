import assert from "node:assert/strict";
import test from "node:test";
import { Agent, expectedPlanTools, extractJsonCandidates, extractTaggedToolCall, mutationSatisfiesPlanItem, streamDisposition } from "../app/agent.js";
import { Registry } from "../app/registry.js";

test("Claude function_calls wrapper is structured even after prose", () => {
  const response = "I'll inspect the files.\n<function_calls>\n[{\"tool\":\"bash\",\"args\":{\"command\":\"find .\"}}]";
  assert.equal(streamDisposition(response), "structured");
});

test("embedded generic tool JSON is withheld from streaming", () => {
  const response = "I will check that now.\n{\"tool\":\"glob\",\"args\":{\"pattern\":\"*.js\"}}";
  assert.equal(streamDisposition(response), "structured");
});

test("alternate single-key tool JSON is withheld from streaming", () => {
  const response = "Checking.\n{\"read\":{\"path\":\"app.js\"}}";
  assert.equal(streamDisposition(response), "structured");
});

test("ordinary prose remains streamable", () => {
  assert.equal(streamDisposition("I found the requested files and they are valid."), "text");
});

test("balanced scanner extracts nested Claude write calls with braces in source", () => {
  const content = [
    "config = {\"nested\": {\"enabled\": True}}",
    "message = f\"value: {config['nested']}\"",
    "print(message)",
  ].join("\n");
  const payload = JSON.stringify([{ tool: "write", args: { path: "obfuscate.py", content } }]);
  const response = `I'll create it now.\n<function_calls>\n${payload}\n</function_calls>`;
  const candidates = extractJsonCandidates(response);

  assert.equal(candidates.length, 1);
  assert.deepEqual(JSON.parse(candidates[0]), JSON.parse(payload));

  const registry = new Registry();
  registry.register({ name: "write", description: "write", parameters: {}, execute() {} });
  const parsed = new Agent(registry)._extractTool(response);
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.tool, { name: "write", args: { path: "obfuscate.py", content } });
});

test("native function call with JSON-string arguments is parsed", () => {
  const registry = new Registry();
  registry.register({ name: "write", description: "write", parameters: {}, execute() {} });
  const response = JSON.stringify({
    function: {
      name: "write",
      arguments: JSON.stringify({ path: "app.py", content: "print({\"ok\": True})\n" }),
    },
  });

  assert.deepEqual(new Agent(registry)._extractTool(response).tool, {
    name: "write",
    args: { path: "app.py", content: "print({\"ok\": True})\n" },
  });
});

test("Anthropic tool_use name and input object are parsed", () => {
  const registry = new Registry();
  registry.register({ name: "read", description: "read", parameters: {}, execute() {} });
  const response = JSON.stringify({
    type: "tool_use",
    id: "toolu_123",
    name: "read",
    input: { path: "/tmp/test-khazai/obfuscator.py" },
  });

  assert.deepEqual(new Agent(registry)._extractTool(response).tool, {
    name: "read",
    args: { path: "/tmp/test-khazai/obfuscator.py" },
  });
});

test("Claude flat tool arguments are normalized from registered parameters", () => {
  const registry = new Registry();
  registry.register({
    name: "read",
    description: "read",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, offset: { type: "number" } },
    },
    execute() {},
  });
  const response = JSON.stringify({
    tool: "read",
    path: "/tmp/test-khazai",
    offset: 4,
    provider_metadata: "must not become a tool argument",
  });

  assert.deepEqual(new Agent(registry)._extractTool(response).tool, {
    name: "read",
    args: { path: "/tmp/test-khazai", offset: 4 },
  });
});

test("OpenAI tool_calls function envelope is parsed", () => {
  const registry = new Registry();
  registry.register({ name: "glob", description: "glob", parameters: {}, execute() {} });
  const response = JSON.stringify({
    tool_calls: [{
      id: "call_123",
      type: "function",
      function: { name: "glob", arguments: '{"pattern":"*","path":"/tmp/test-khazai"}' },
    }],
  });

  assert.deepEqual(new Agent(registry)._extractTool(response).tool, {
    name: "glob",
    args: { pattern: "*", path: "/tmp/test-khazai" },
  });
});

test("Claude XML invoke parameters are parsed without exposing tool text", () => {
  const registry = new Registry();
  registry.register({
    name: "bash",
    description: "shell",
    parameters: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number" } } },
    execute() {},
  });
  const response = [
    "<function_calls>",
    "<invoke name=\"bash\">",
    "<parameter name=\"command\">ls -la /tmp/test-khazai &amp;&amp; pwd</parameter>",
    "<parameter name=\"timeout\">30</parameter>",
    "</invoke>",
    "</function_calls>",
  ].join("\n");

  assert.equal(streamDisposition(response), "structured");
  assert.deepEqual(extractTaggedToolCall(response, registry), {
    name: "bash",
    args: { command: "ls -la /tmp/test-khazai && pwd", timeout: 30 },
  });
  assert.deepEqual(new Agent(registry)._extractTool(response).tool, {
    name: "bash",
    args: { command: "ls -la /tmp/test-khazai && pwd", timeout: 30 },
  });
});

test("Claude XML tool_name and direct parameter tags are parsed", () => {
  const registry = new Registry();
  registry.register({
    name: "read",
    description: "read",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    execute() {},
  });
  const response = "<tool_call><tool_name>read</tool_name><parameters><path>/tmp/test.py</path></parameters></tool_call>";

  assert.deepEqual(new Agent(registry)._extractTool(response).tool, {
    name: "read",
    args: { path: "/tmp/test.py" },
  });
});

test("function-style tool-like text is parsed and withheld", () => {
  const registry = new Registry();
  registry.register({ name: "read", description: "read", parameters: {}, execute() {} });
  const response = 'read({"path":"/tmp/test.py"})';

  assert.equal(streamDisposition(response), "structured");
  assert.deepEqual(new Agent(registry)._extractTool(response).tool, {
    name: "read",
    args: { path: "/tmp/test.py" },
  });
});

test("double-encoded JSON tool call is parsed", () => {
  const registry = new Registry();
  registry.register({ name: "glob", description: "glob", parameters: {}, execute() {} });
  const encoded = JSON.stringify(JSON.stringify({ tool: "glob", args: { pattern: "*" } }));

  assert.deepEqual(new Agent(registry)._extractTool(encoded).tool, {
    name: "glob",
    args: { pattern: "*" },
  });
});

test("labeled tool-like text with JSON arguments is parsed", () => {
  const registry = new Registry();
  registry.register({ name: "read", description: "read", parameters: {}, execute() {} });
  const response = 'Tool: read\nArguments: {"path":"/tmp/test.py"}';

  assert.equal(streamDisposition(response), "structured");
  assert.deepEqual(new Agent(registry)._extractTool(response).tool, {
    name: "read",
    args: { path: "/tmp/test.py" },
  });
});

test("incomplete write JSON is classified as truncated", () => {
  const registry = new Registry();
  registry.register({ name: "write", description: "write", parameters: {}, execute() {} });
  const parsed = new Agent(registry)._extractTool(
    '```json\n{"tool":"write","args":{"path":"large.py","content":"class Partial:\\n',
  );

  assert.equal(parsed.tool, null);
  assert.equal(parsed.truncated, true);
  assert.match(parsed.error, /truncated/i);
});

test("implementation todos only accept mutation tools", () => {
  assert.deepEqual(expectedPlanTools("Implement the requested changes"), ["write", "edit", "apply_patch"]);
  assert.deepEqual(expectedPlanTools("Build the requested CLI"), ["write", "edit", "apply_patch"]);
});

test("one write advances only overlapping requirements proven by source", () => {
  const tool = {
    name: "write",
    args: {
      path: "/tmp/obfuscate.py",
      content: "import argparse, marshal\ntry:\n    compile('pass', '<x>', 'exec')\nexcept Exception:\n    pass\n",
    },
  };
  assert.equal(mutationSatisfiesPlanItem(tool, "Implement obfuscation using marshal"), true);
  assert.equal(mutationSatisfiesPlanItem(tool, "Add syntax validation before and after obfuscation"), true);
  assert.equal(mutationSatisfiesPlanItem(tool, "Implement error handling"), true);
  assert.equal(mutationSatisfiesPlanItem(tool, "Create unit test cases"), false);
  assert.equal(mutationSatisfiesPlanItem(tool, "Create README.md documentation"), false);
});
