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
  "think",
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

test("production built-in tool surface includes supported KhazAI tools", () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-tool-surface-"));
  assert.deepEqual(builtinTools(workspace).map(tool => tool.name), BUILTIN_NAMES);
  assert.equal(builtinTools(workspace).some(tool =>
    ["apply_patch", "analyze", "repo", "lsp", "web"].includes(tool.name)
  ), false);
  const think = builtinTools(workspace).find(tool => tool.name === "think");
  assert.deepEqual(think.parameters.required, ["activity"]);
  assert.deepEqual(Object.keys(think.parameters.properties), [
    "activity",
    "target",
    "nextAction",
    "progress",
  ]);
});

test("Think streams only complete redacted public activity and keeps reasoning private", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-think-activity-"));
  const registry = new Registry();
  const think = builtinTools(workspace).find(tool => tool.name === "think");
  registry.register(think);
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  let request = 0;
  const agent = new Agent(registry, {
    workspace,
    chat: async (_messages, options) => {
      request++;
      if (request === 1) {
        options.onEvent?.({ type: "reasoning-delta", text: "private decision chain" });
        options.onEvent?.({
          type: "tool-call-delta",
          delta: [{
            index: 0,
            id: "think-live",
            function: {
              name: "think",
              arguments: "{\"activity\":\"Inspecting session state\",\"target\":\"",
            },
          }],
        });
        options.onEvent?.({
          type: "tool-call-delta",
          delta: [{
            index: 0,
            function: {
              arguments: `${secret}\",\"nextAction\":\"Read the active handler\",\"progress\":\"1/3\"}`,
            },
          }],
        });
        options.onEvent?.({ type: "finish", reason: "tool-calls" });
        return JSON.stringify({
          tool: "think",
          id: "think-live",
          args: {
            activity: "Inspecting session state",
            target: secret,
            nextAction: "Read the active handler",
            progress: "1/3",
          },
        });
      }
      options.onEvent?.({ type: "text-delta", text: "Done." });
      options.onEvent?.({ type: "finish", reason: "stop" });
      return "Done.";
    },
  });
  const events = [];
  for await (const event of agent.loop(`Inspect ${secret}`)) events.push(event);
  const activities = events.filter(event => event.type === "public-activity");

  assert.equal(activities.length, 1);
  assert.equal(activities[0].toolCallId, "think-live");
  assert.equal(activities[0].publicActivity.target, "[REDACTED]");
  assert.equal(events.some(event => event.type === "reasoning"), false);
  assert.equal(events.some(event => JSON.stringify(event).includes("private decision chain")), false);
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
