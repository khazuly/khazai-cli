import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent } from "../app/agent.js";
import { InstructionService } from "../app/instruction.js";
import { Registry } from "../app/registry.js";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "khazai-instructions-"));
  const nested = join(root, "packages", "app");
  mkdirSync(join(root, ".git"));
  mkdirSync(nested, { recursive: true });
  return { root, nested };
}

test("nearest AGENTS.md is cached and reloaded only after it changes", () => {
  const { root, nested } = workspace();
  const rootPath = join(root, "AGENTS.md");
  const nestedPath = join(root, "packages", "AGENTS.md");
  writeFileSync(rootPath, "root instruction");
  writeFileSync(nestedPath, "nested instruction");
  const service = new InstructionService(nested, root);
  const first = service.snapshot();
  const second = service.snapshot();
  assert.equal(first.entries[0], second.entries[0]);
  assert.match(service.getSystemPromptBlock(), /nested instruction/);
  assert.doesNotMatch(service.getSystemPromptBlock(), /root instruction/);
  writeFileSync(nestedPath, "nested instruction changed");
  assert.match(service.getSystemPromptBlock(), /nested instruction changed/);
});

test("AGENTS.md is hidden system context before every agent request", async () => {
  const { root, nested } = workspace();
  const instructionPath = join(root, "AGENTS.md");
  writeFileSync(instructionPath, "Run the focused verification command.");
  const observed = [];
  const createAgent = () => new Agent(new Registry(), {
    workspace: nested,
    chat: async messages => {
      observed.push(messages);
      return "Done.";
    },
  });
  for (const prompt of ["First task", "Second task"]) {
    for await (const _event of createAgent().loop(prompt)) {}
  }
  assert.equal(observed.length, 2);
  for (const messages of observed) {
    assert.equal(messages[0].role, "system");
    assert.match(messages[0].content, new RegExp(instructionPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(messages[0].content, /Run the focused verification command/);
    assert.equal(messages.filter(message => message.role === "user" && /Run the focused/.test(String(message.content))).length, 0);
  }
});
