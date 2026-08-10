import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement as h } from "react";
import { render } from "ink";
import { Agent } from "../app/agent.js";
import { toolIsReadOnly } from "../app/plan-mode.js";
import { Registry } from "../app/registry.js";
import { PromptInput } from "../ui/components/prompt-input.js";
import { renderComponent, TerminalInput, TerminalOutput } from "./helpers/ink-render.js";

function tool(name, execute) {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute,
  };
}

test("Plan agent exposes edit and Bash and requests permission before execution", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-plan-permission-"));
  const registry = new Registry();
  let writes = 0;
  let commands = 0;
  registry.register(tool("write", async () => { writes++; return "written"; }));
  registry.register(tool("bash", async () => { commands++; return "Exit: 0"; }));
  let schemas = [];
  const responses = [JSON.stringify({ tool: "write", args: {}, id: "write-1" }), "Plan complete."];
  const agent = new Agent(registry, {
    workspace,
    agent: "plan",
    chat: async (_messages, options) => {
      schemas = options.tools.map(item => item.function.name);
      assert.match(_messages[0].content, /require user approval/i);
      const response = responses.shift();
      options.onToken?.(response);
      return response;
    },
  });
  agent.setPermissionHandler(() => "Allow once");
  const events = [];
  for await (const event of agent.loop("Plan and test permissions")) events.push(event);
  assert.deepEqual(schemas.sort(), ["bash", "write"]);
  assert.equal(events.filter(event => event.type === "permission").length, 1);
  assert.equal(writes, 1);
  assert.equal(commands, 0);
  assert.equal(agent._permissionService.evaluate("bash", { command: "git status" }).decision, "ask");
});

test("initialization read-only policy remains separate from Plan permissions", () => {
  assert.equal(toolIsReadOnly({ name: "read" }), true);
  assert.equal(toolIsReadOnly({ name: "write" }), false);
  assert.equal(toolIsReadOnly({ name: "mcp__docs__search" }, { mcp: { readOnly: true } }), true);
});

test("empty prompt Tab toggles the primary agent callback", async () => {
  const stdout = new TerminalOutput(60, 12);
  const stdin = new TerminalInput();
  let toggles = 0;
  const instance = render(h(PromptInput, {
    onSubmit() {},
    onCommand() {},
    onToggleAgent: () => { toggles++; },
    commands: [],
    inputActive: true,
  }), { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false });
  stdin.push("\t");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(toggles, 1);
  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});

test("Plan footer keeps KhazAI Plan Mode copy", async () => {
  const frame = await renderComponent(h(PromptInput, {
    onSubmit() {}, onCommand() {}, commands: [], inputActive: true,
  }), 50, 10);
  assert.match(frame, /Ask anything/);
});
