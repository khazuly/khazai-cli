import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h } from "react";
import { render } from "ink";
import { PromptInput } from "../ui/components/prompt-input.js";
import { manageMcpCommand } from "../ui/mcp-command.js";
import { stripAnsi, TerminalInput, TerminalOutput } from "./helpers/ink-render.js";

test("MCP manager opens with every configured server", async () => {
  const questions = [];
  const manager = {
    workspace: "/tmp",
    status: () => Array.from({ length: 8 }, (_, index) => ({
      id: `server-${index + 1}`,
      type: "stdio",
      state: "disconnected",
      toolCount: index,
      enabled: true,
    })),
  };
  await manageMcpCommand("", {
    manager,
    requestValue: async (question, options) => {
      questions.push({ question, options });
      return "";
    },
    respond() {},
    syncTools() {},
  });
  assert.equal(questions[0].question, "MCP Servers");
  assert.equal(questions[0].options.length, 9);
  assert.ok(questions[0].options.some(option => option.startsWith("server-8 ·")));
});

test("MCP option navigation scrolls beyond six visible rows", async () => {
  const stdout = new TerminalOutput(52, 16);
  const stdin = new TerminalInput();
  const options = Array.from({ length: 8 }, (_, index) => `server-${index + 1}`);
  const selected = [];
  const instance = render(h(PromptInput, {
    onSubmit() {},
    onCommand() {},
    commands: [],
    question: "MCP Servers",
    questionKind: "mcp",
    questionOptions: options,
    onSelectOption: value => selected.push(value),
  }), {
    stdout,
    stdin,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  for (let index = 0; index < 6; index++) {
    stdin.push("\u001b[B");
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  stdin.push("\r");
  await new Promise(resolve => setTimeout(resolve, 40));
  const output = stripAnsi(stdout.frames.join(""));
  assert.deepEqual(selected, ["server-7"]);
  assert.match(output, /2–7 of 8/);
  assert.match(output, /server-7/);
  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});
