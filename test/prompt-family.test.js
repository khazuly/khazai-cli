import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../app/agent.js";
import { Registry } from "../app/registry.js";
import {
  getFamilyPrompt,
  getModePrompt,
  getProviderPrompt,
  promptFamily,
  resolvePromptProfile,
} from "../app/prompts.js";

test("prompt families follow OpenCode's model-based routing while preserving KhazAI branding", () => {
  assert.equal(promptFamily("codex/gpt-5.3-codex"), "codex");
  assert.equal(promptFamily("codex/gpt-5.6-terra"), "gpt");
  assert.equal(promptFamily("anthropic/claude-sonnet"), "anthropic");
  assert.equal(promptFamily("google/gemini-3-pro"), "gemini");
  assert.equal(promptFamily("opencode/big-pickle"), "default");
  const codex = getProviderPrompt("codex/gpt-5.3-codex");
  const gpt = getProviderPrompt("codex/gpt-5.6-terra");
  assert.match(codex, /You are KhazAI/);
  assert.match(codex, /call the appropriate tool immediately/);
  assert.match(codex, /Prefer read, glob, grep, edit, and write for file operations/);
  assert.match(codex, /syntax or typecheck first/);
  assert.match(codex, /Never pipe test output through grep or tail/);
  assert.match(codex, /Never use git stash, git reset, or git checkout/);
  assert.match(codex, /# Codex behavior/);
  assert.doesNotMatch(gpt, /# Codex behavior/);
  assert.match(gpt, /# GPT behavior/);
  assert.match(gpt, /keep private reasoning internal/i);
  assert.match(gpt, /Never put reasoning, evidence chains, secrets/i);
});

test("explicit model metadata controls the shared prompt profile", () => {
  const descriptor = {
    modelID: "internal-model",
    definition: { family: "google", promptProfile: "gemini" },
  };
  const family = getFamilyPrompt(descriptor);
  const build = getModePrompt("build");
  assert.equal(resolvePromptProfile(descriptor), "gemini");
  assert.match(family, /# Gemini behavior/);
  assert.doesNotMatch(family, /# Build mode|# Plan mode/);
  assert.match(build, /# Build mode/);
  assert.equal(getFamilyPrompt(descriptor), family);
});

test("system prompts keep environment, workspace, MCP, and skill layers ordered", () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-prompt-layers-"));
  writeFileSync(join(workspace, "AGENTS.md"), "# Test instructions\n\nFollow the workspace rule.");
  const skillDirectory = join(workspace, ".khazai", "skills", "prompt-check");
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(
    join(skillDirectory, "SKILL.md"),
    "---\nname: prompt-check\ndescription: Validate prompt layering.\n---\nUse the requested profile.\n",
  );
  const registry = new Registry()
    .register({
      name: "skill",
      description: "Load a skill",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() { return "skill"; },
    })
    .register({
      name: "mcp_check",
      description: "Check MCP",
      parameters: { type: "object", properties: {}, required: [] },
      mcp: { instructions: "Use the test MCP when requested." },
      async execute() { return "mcp"; },
    });
  const system = new Agent(registry, { workspace, model: "codex/gpt-5.4" })._buildSystem();
  const markers = [
    "# Codex behavior",
    "# Build mode",
    "Here is some useful information about the environment",
    "WORKSPACE INSTRUCTIONS (HIGH PRIORITY):",
    "MCP SERVER INSTRUCTIONS:",
    "AVAILABLE SKILLS:",
  ].map(marker => system.indexOf(marker));
  assert.equal(markers.every(index => index >= 0), true, String(markers));
  assert.deepEqual([...markers].sort((left, right) => left - right), markers);
});

test("model switching rebuilds the family prompt without clearing canonical task context", () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-prompt-switch-"));
  const agent = new Agent(new Registry(), {
    workspace,
    model: "codex/gpt-5.4",
    config: {
      providers: {
        local: { baseURL: "https://local.test/v1", family: "google", promptProfile: "gemini" },
      },
    },
  });
  agent._messages = [{ role: "user", content: "Keep this active task." }];
  agent._currentRequest = "Keep this active task.";
  const codex = agent._buildSystem();
  agent.setModel("local/test-model");
  const gemini = agent._buildSystem();
  assert.match(codex, /# Codex behavior/);
  assert.match(gemini, /# Gemini behavior/);
  assert.deepEqual(agent._messages, [{ role: "user", content: "Keep this active task." }]);
  assert.equal(agent._currentRequest, "Keep this active task.");
});
