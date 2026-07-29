import assert from "node:assert/strict";
import test from "node:test";
import { getProviderPrompt, promptFamily } from "../app/prompts.js";

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
  assert.match(codex, /Prefer Read, Glob, Grep, Edit, and Write for file operations/);
  assert.match(codex, /# Codex behavior/);
  assert.doesNotMatch(gpt, /# Codex behavior/);
  assert.match(gpt, /# GPT behavior/);
  assert.match(gpt, /keep private reasoning internal/i);
  assert.match(gpt, /Never put reasoning, evidence chains, secrets/i);
});
