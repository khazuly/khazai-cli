import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveProviderAuth } from "../lib/auth.js";
import { CodexResponsesProvider } from "../lib/codex-provider.js";

test("Codex Responses provider sends the OpenCode OAuth protocol and decodes tool calls", async () => {
  const originalFetch = globalThis.fetch;
  const root = mkdtempSync(join(tmpdir(), "khazai-codex-"));
  const authPath = join(root, "auth.json");
  saveProviderAuth("codex", {
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
    accountId: "account-1",
  }, authPath);
  const encoder = new TextEncoder();
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "call_1", name: "read", arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":"README.md"}' },
    { type: "response.function_call_arguments.done", output_index: 0, call_id: "call_1", name: "read", arguments: '{"path":"README.md"}' },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, headers: options.headers, body: JSON.parse(options.body) };
    return {
      ok: true,
      headers: { get: () => "text/event-stream" },
      body: new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(events)); controller.close(); } }),
    };
  };
  try {
    const provider = new CodexResponsesProvider({ model: "gpt-5.4", authPath });
    const result = await provider.chat([{ role: "system", content: "Be useful" }, { role: "user", content: "Read it" }], {
      reasoningEffort: "high",
      tools: [{ type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object" } } }],
    });
    assert.equal(result, JSON.stringify({ tool: "read", args: { path: "README.md" }, id: "call_1" }));
    assert.equal(request.headers.Authorization, "Bearer access-token");
    assert.equal(request.headers["ChatGPT-Account-Id"], "account-1");
    assert.equal(request.headers.originator, "opencode");
    assert.equal(request.headers["OpenAI-Beta"], "responses=experimental");
    assert.equal(request.body.instructions, "Be useful");
    assert.equal(request.body.model, "gpt-5.4");
    assert.deepEqual(request.body.reasoning, { effort: "high", summary: "auto" });
    assert.equal(request.body.tools[0].name, "read");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Codex model discovery uses the authenticated Codex models endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const root = mkdtempSync(join(tmpdir(), "khazai-codex-models-"));
  const authPath = join(root, "auth.json");
  saveProviderAuth("codex", {
    type: "oauth", access: "access-token", refresh: "refresh-token", expires: Date.now() + 60_000, accountId: "account-1",
  }, authPath);
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, headers: options.headers };
    return { ok: true, async json() { return { data: [{ id: "gpt-z" }, { id: "gpt-a" }] }; } };
  };
  try {
    const provider = new CodexResponsesProvider({ model: "unused", endpoint: "https://example.test/backend-api/codex/responses", authPath });
    assert.deepEqual(await provider.listModels(), ["gpt-a", "gpt-z"]);
    assert.equal(request.url, "https://example.test/backend-api/codex/models?client_version=1.0.0");
    assert.equal(request.headers.Authorization, "Bearer access-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Codex accepts completed message events that omit text deltas", async () => {
  const originalFetch = globalThis.fetch;
  const root = mkdtempSync(join(tmpdir(), "khazai-codex-complete-"));
  const authPath = join(root, "auth.json");
  saveProviderAuth("codex", {
    type: "oauth", access: "access-token", refresh: "refresh-token", expires: Date.now() + 60_000, accountId: "account-1",
  }, authPath);
  const payload = `data: ${JSON.stringify({
    type: "response.output_item.done",
    item: { type: "message", content: [{ type: "output_text", text: "Done." }] },
  })}`;
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => "text/event-stream" },
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(payload)); controller.close(); } }),
  });
  try {
    const provider = new CodexResponsesProvider({ model: "gpt-test", authPath });
    assert.equal(await provider.chat([{ role: "user", content: "Hello" }]), "Done.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Codex accepts completed function-call events that omit argument deltas", async () => {
  const originalFetch = globalThis.fetch;
  const root = mkdtempSync(join(tmpdir(), "khazai-codex-tool-complete-"));
  const authPath = join(root, "auth.json");
  saveProviderAuth("codex", {
    type: "oauth", access: "access-token", refresh: "refresh-token", expires: Date.now() + 60_000, accountId: "account-1",
  }, authPath);
  const payload = `data: ${JSON.stringify({
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "function_call", call_id: "call_1", name: "glob", arguments: '{"pattern":"*"}' },
  })}`;
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => "text/event-stream" },
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(payload)); controller.close(); } }),
  });
  try {
    const provider = new CodexResponsesProvider({ model: "gpt-test", authPath });
    assert.equal(
      await provider.chat([{ role: "user", content: "List files" }]),
      JSON.stringify({ tool: "glob", args: { pattern: "*" }, id: "call_1" }),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
