import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../app/agent.js";
import { builtinTools } from "../app/builtin-tools.js";
import { Registry } from "../app/registry.js";
import { readTool, writeTool, editTool } from "../tools/file.js";

const BUILTIN_NAMES = [
  "question",
  "bash",
  "read",
  "glob",
  "grep",
  "edit",
  "write",
  "task",
  "webfetch",
  "todowrite",
  "websearch",
  "skill",
];

test("production built-in tool surface matches OpenCode", () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-tool-surface-"));
  assert.deepEqual(builtinTools(workspace).map(tool => tool.name), BUILTIN_NAMES);
  assert.equal(builtinTools(workspace).some(tool =>
    ["apply_patch", "analyze", "repo", "lsp", "web"].includes(tool.name)
  ), false);
});

test("agent never rewrites read into glob", () => {
  const registry = new Registry();
  registry.register(readTool);
  const agent = new Agent(registry, {
    workspace: mkdtempSync(join(tmpdir(), "khazai-no-router-")),
  });
  const call = { name: "read", args: { path: "." } };
  assert.equal(agent._normalizeTool(call), call);
});

test("file tools do not run hidden syntax, dependency, or fuzzy-edit automation", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-file-contract-"));
  const path = join(workspace, "broken.py");
  const written = await writeTool.execute({
    path,
    content: "def broken(:\n",
    _agentWorkspace: workspace,
  });
  assert.match(written, /^Written /);
  assert.equal(readFileSync(path, "utf-8"), "def broken(:\n");

  writeFileSync(path, "alpha   beta\n");
  const edited = await editTool.execute({
    path,
    oldString: "alpha beta",
    newString: "changed",
    _agentWorkspace: workspace,
  });
  assert.match(edited, /oldString not found/);
  assert.equal(readFileSync(path, "utf-8"), "alpha   beta\n");

  const directory = join(workspace, "folder");
  mkdirSync(directory);
  const read = await readTool.execute({ path: directory, _agentWorkspace: workspace });
  assert.match(read, /is a directory/);
  assert.doesNotMatch(read, /glob/i);
});

test("tool results return to the provider as native assistant and tool roles", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-native-history-"));
  writeFileSync(join(workspace, "sample.txt"), "native history\n");
  const registry = new Registry();
  registry.register(readTool);
  const requests = [];
  let turn = 0;
  const agent = new Agent(registry, {
    workspace,
    chat: async messages => {
      requests.push(structuredClone(messages));
      turn++;
      if (turn === 1) {
        return JSON.stringify({
          tool: "read",
          args: { path: "sample.txt" },
          id: "call-native-history",
        });
      }
      return "Done.";
    },
  });

  for await (const _event of agent.loop("Read sample.txt")) {
    // Consume the complete turn.
  }

  const history = requests[1];
  const assistant = history.find(message => message.role === "assistant" && message.tool_calls);
  const result = history.find(message => message.role === "tool");
  assert.equal(assistant.tool_calls[0].id, "call-native-history");
  assert.equal(assistant.tool_calls[0].function.name, "read");
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { path: "sample.txt" });
  assert.equal(result.tool_call_id, "call-native-history");
  assert.equal(result.name, "read");
  assert.match(result.content, /native history/);
  assert.doesNotMatch(JSON.stringify(history), /INTERNAL STEERING|---TOOL RESULT/);
});
