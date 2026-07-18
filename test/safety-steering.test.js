import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../app/agent.js";
import { Registry } from "../app/registry.js";
import { writeTool, editTool } from "../tools/file.js";

function scripted(responses) {
  return async (_messages, options) => {
    const response = responses.shift();
    options.onToken?.(response);
    return response;
  };
}

test("write and broad edit follow OpenCode behavior without behavioral steering", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-file-parity-"));
  const path = join(workspace, "app.js");
  writeFileSync(path, "export const value = 1;\n");
  assert.match(
    await writeTool.execute({ path, content: "export const value = 2;\n", _agentWorkspace: workspace }),
    /^Written /,
  );
  assert.match(
    await editTool.execute({
      path,
      oldString: "export const value = 2;\n",
      newString: "export const value = 3;\n",
      _agentWorkspace: workspace,
    }),
    /^Edited /,
  );
  assert.equal(readFileSync(path, "utf-8"), "export const value = 3;\n");
  rmSync(workspace, { recursive: true, force: true });
});

test("model completion is accepted without semantic evidence redirects", async () => {
  const registry = new Registry();
  const agent = new Agent(registry, {
    workspace: mkdtempSync(join(tmpdir(), "khazai-model-completion-")),
    chat: scripted(["Implemented as requested."]),
    intentResolver: async () => ({
      intent: "change",
      category: "MODIFICATION",
      operation: "modify_code",
      requiredEvidence: ["mutation", "validation"],
      requiresPlan: false,
    }),
  });
  const events = [];
  for await (const event of agent.loop("fix the bug and run tests")) events.push(event);
  assert.equal(events.some(event => event.type === "steering"), false);
  assert.match(events.filter(event => event.type === "stream").map(event => event.token).join(""), /Implemented/);
});

test("malformed calls become structured invalid results without steering", async () => {
  const registry = new Registry();
  registry.register({
    name: "write",
    description: "write",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    async execute() { return "Written"; },
  });
  const agent = new Agent(registry, {
    workspace: mkdtempSync(join(tmpdir(), "khazai-tool-error-")),
    chat: scripted(['{"tool":"write","args":{"path":"x.js"', "Unable to continue."]),
    intentResolver: async () => ({
      intent: "change",
      category: "MODIFICATION",
      operation: "modify_code",
      requiredEvidence: ["mutation"],
      requiresPlan: false,
    }),
  });
  const events = [];
  for await (const event of agent.loop("write x.js")) events.push(event);
  const errorPart = events.find(event => event.type === "tool-part" && event.part?.state?.status === "error");
  assert.equal(errorPart?.part.tool, "invalid_tool_call");
  assert.equal(events.some(event => event.type === "steering"), false);
  assert.equal(events.some(event => event.type === "stream-discard"), true);
  assert.doesNotMatch(events.filter(event => event.type === "stream").map(event => event.token).join(""), /tool_call/i);
});
