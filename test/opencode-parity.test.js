import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOpenCodeCredential, getProviderCredential, saveProviderCredential } from "../lib/auth.js";
import { OpenAICompatibleProvider } from "../lib/providers.js";
import { chatWithRetry, isTransientProviderError, providerRetryDelay } from "../lib/llm.js";
import { PermissionService } from "../app/permission.js";
import { SessionStore, migrateSessionV2 } from "../app/session-store.js";
import { loadAgentProfiles } from "../app/agent-profiles.js";

test("provider credentials use mode 0600 and environment variables take precedence", () => {
  const root = mkdtempSync(join(tmpdir(), "khazai-auth-"));
  const path = join(root, "auth.json");
  saveProviderCredential("local", "stored-secret", path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(getProviderCredential("local", "KHAZAI_TEST_KEY", path), "stored-secret");
  process.env.KHAZAI_TEST_KEY = "environment-secret";
  try {
    assert.equal(getProviderCredential("local", "KHAZAI_TEST_KEY", path), "environment-secret");
  } finally {
    delete process.env.KHAZAI_TEST_KEY;
  }
});

test("Big Cock reuses the OpenCode Zen credential when it exists", () => {
  const root = mkdtempSync(join(tmpdir(), "khazai-opencode-auth-"));
  const path = join(root, "auth.json");
  writeFileSync(path, JSON.stringify({ opencode: { type: "api", key: "zen-key" } }));
  assert.equal(getOpenCodeCredential(path), "zen-key");
});

test("OpenCode auth content is reused without exporting an API key", () => {
  const environment = {
    OPENCODE_AUTH_CONTENT: JSON.stringify({ opencode: { type: "api", key: "inherited-zen-key" } }),
  };
  assert.equal(getOpenCodeCredential("/missing/auth.json", environment), "inherited-zen-key");
});

test("session lists only include sessions from the current workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "khazai-workspace-sessions-"));
  const data = join(root, "data");
  const workspaceA = join(root, "workspace-a");
  const workspaceB = join(root, "workspace-b");
  mkdirSync(workspaceA);
  mkdirSync(workspaceB);
  const storeA = new SessionStore(workspaceA, data);
  const storeB = new SessionStore(workspaceB, data);
  const sessionA = storeA.create({ title: "Workspace A" });
  const sessionB = storeB.create({ title: "Workspace B" });

  writeFileSync(storeA.path(sessionB.id), readFileSync(storeB.path(sessionB.id)));

  assert.deepEqual(storeA.list().map(session => session.id), [sessionA.id]);
  assert.deepEqual(storeB.list().map(session => session.id), [sessionB.id]);
});

test("OpenAI-compatible streaming assembles native tool-call deltas", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const payload = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "re", arguments: "{\"pa" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "ad", arguments: "th\":\"README.md\"}" } }] } }] },
  ].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n";
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => "text/event-stream" },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(payload));
        controller.close();
      },
    }),
  });
  try {
    const provider = new OpenAICompatibleProvider({ id: "local", baseURL: "http://localhost:1234/v1" });
    assert.equal(
      await provider.chat([{ role: "user", content: "read" }], { model: "test" }),
      JSON.stringify({ tool: "read", args: { path: "README.md" }, id: "call_1" }),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("native tool calls preserve preceding streamed prose", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const payload = [
    { choices: [{ delta: { content: "I will inspect the file first." } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_read", function: { name: "read", arguments: '{\"path\":\"a.js\"}' } }] } }] },
  ].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n";
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => "text/event-stream" },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(payload));
        controller.close();
      },
    }),
  });
  const events = [];
  try {
    const provider = new OpenAICompatibleProvider({ id: "local", baseURL: "http://localhost:1234/v1" });
    const result = await provider.chat([], { model: "test", onEvent: event => events.push(event) });
    assert.equal(events.filter(event => event.type === "text-delta").map(event => event.text).join(""), "I will inspect the file first.");
    assert.match(result, /\"tool\":\"read\"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("shared provider retry discards failed attempt deltas and preserves context", async () => {
  const messages = [{ role: "user", content: "Continue from completed tools." }];
  const seen = [];
  let calls = 0;
  const provider = {
    id: "opencode",
    async chat(received, options) {
      calls++;
      assert.equal(received, messages);
      options.onEvent?.({ type: "text-delta", text: calls < 3 ? `partial-${calls}` : "Final answer." });
      if (calls < 3) {
        const error = new Error("HTTP 500: Internal Server Error");
        error.status = 500;
        error.retryAfterMs = 0;
        error.requestId = `request-${calls}`;
        throw error;
      }
      return "Final answer.";
    },
  };
  const result = await chatWithRetry(provider, messages, {
    model: "gpt-5.6-luna",
    runId: "run-1",
    turnId: "turn-1",
    onEvent: event => seen.push(event),
  }, 3);
  assert.equal(result, "Final answer.");
  assert.equal(calls, 3);
  assert.deepEqual(seen, [{ type: "text-delta", text: "Final answer." }]);
});

test("shared provider retry exhausts once and cancellation stops backoff", async () => {
  let calls = 0;
  const provider = {
    id: "opencode",
    async chat() {
      calls++;
      const error = new Error("HTTP 500: Internal Server Error");
      error.status = 500;
      error.retryAfterMs = 0;
      throw error;
    },
  };
  let exhausted;
  try {
    await chatWithRetry(provider, [], { model: "gpt-5.6-luna" }, 3);
  } catch (error) {
    exhausted = error;
  }
  assert.equal(calls, 3);
  assert.equal(exhausted.attempts, 3);
  assert.equal(exhausted.retryLog.length, 3);

  calls = 0;
  const controller = new AbortController();
  const cancelling = {
    ...provider,
    async chat() {
      const result = provider.chat();
      controller.abort(new Error("Cancelled"));
      return result;
    },
  };
  await assert.rejects(
    chatWithRetry(cancelling, [], { model: "gpt-5.6-luna", signal: controller.signal }, 3),
    /Cancelled/,
  );
  assert.equal(calls, 1);
});

test("transient classification and retry timing exclude invalid requests", () => {
  assert.equal(isTransientProviderError({ status: 503 }), true);
  assert.equal(isTransientProviderError({ status: 429 }), true);
  assert.equal(isTransientProviderError({ code: "ECONNRESET" }), true);
  assert.equal(isTransientProviderError(new TypeError("fetch failed")), true);
  assert.equal(isTransientProviderError({ code: "PREMATURE_STREAM" }), true);
  assert.equal(isTransientProviderError({ status: 400 }), false);
  assert.equal(isTransientProviderError({ status: 401 }), false);
  assert.equal(isTransientProviderError(new Error("Missing API key")), false);
  assert.equal(providerRetryDelay({ retryAfterMs: 4_000 }, 0, () => 0), 4_000);
  assert.equal(providerRetryDelay({}, 0, () => 0.5), 1_000);
  assert.equal(providerRetryDelay({}, 1, () => 0.5), 2_500);
});

test("OpenAI-compatible provider rejects a prematurely terminated stream", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => "text/event-stream" },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\\n\\n'));
        controller.close();
      },
    }),
  });
  try {
    const provider = new OpenAICompatibleProvider({ id: "local", baseURL: "http://localhost:1234/v1" });
    await assert.rejects(
      provider.chat([], { model: "test" }),
      error => error.code === "PREMATURE_STREAM",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("permission defaults match OpenCode and remember always approval", () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-permission-"));
  const service = new PermissionService(workspace, { permission: {} });
  assert.equal(service.evaluate("read", { path: "src/index.js" }).decision, "allow");
  assert.equal(service.evaluate("read", { path: ".env" }).decision, "deny");
  assert.equal(service.evaluate("bash", { command: "rg TODO ." }).decision, "allow");
  const write = service.evaluate("write", { path: "src/index.js" });
  assert.equal(write.decision, "allow");
  const guarded = new PermissionService(workspace, { permission: { edit: "ask" } });
  const requested = guarded.evaluate("write", { path: "src/index.js" });
  assert.equal(requested.decision, "ask");
  guarded.allowForSession("write", requested.always);
  assert.equal(guarded.evaluate("write", { path: "src/index.js" }).decision, "allow");
  assert.equal(guarded.evaluate("write", { path: "src/other.js" }).decision, "ask");
});

test("legacy sessions migrate to structured version 2 idempotently", () => {
  const migrated = migrateSessionV2({
    version: 1,
    id: "session-1",
    workspace: "/tmp/project",
    messages: [{ id: "t1", type: "tool", tool: "read", args: { path: "a.js" }, content: "source", done: true }],
    agentState: { messages: [] },
    turns: [],
  });
  assert.equal(migrated.version, 2);
  assert.equal(migrated.agentState.version, 2);
  assert.equal(migrated.parts[0].state.status, "completed");
  assert.deepEqual(migrateSessionV2(migrated), migrated);
});

test("permission mode is session scoped and restored only when resumed", () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-permission-mode-"));
  const data = mkdtempSync(join(tmpdir(), "khazai-permission-mode-data-"));
  const store = new SessionStore(workspace, data);
  const fresh = store.create();
  assert.equal(fresh.permissionMode, "prompt");

  const allowed = store.save({ ...fresh, permissionMode: "allow-all" });
  assert.equal(store.load(allowed.id).permissionMode, "allow-all");
  assert.equal(store.create().permissionMode, "prompt");
});

test("session undo and redo restore tracked and untracked files", () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-session-work-"));
  const data = mkdtempSync(join(tmpdir(), "khazai-session-data-"));
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace });
  writeFileSync(join(workspace, "tracked.txt"), "before\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: workspace });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: workspace });

  const store = new SessionStore(workspace, data);
  let session = store.create();
  const before = store.captureGitState();
  writeFileSync(join(workspace, "tracked.txt"), "after\n");
  writeFileSync(join(workspace, "new.txt"), "created\n");
  const messages = [
    { id: "u1", type: "user", content: "change files" },
    { id: "a1", type: "answer", content: "done" },
  ];
  session = store.recordTurn(session, {
    input: "change files",
    before,
    after: store.captureGitState(),
    messages,
    agentState: { messages: [] },
  });

  session = store.undo(session).session;
  assert.equal(readFileSync(join(workspace, "tracked.txt"), "utf-8"), "before\n");
  assert.throws(() => readFileSync(join(workspace, "new.txt")));
  assert.deepEqual(session.messages, []);

  session = store.redo(session).session;
  assert.equal(readFileSync(join(workspace, "tracked.txt"), "utf-8"), "after\n");
  assert.equal(readFileSync(join(workspace, "new.txt"), "utf-8"), "created\n");
  assert.deepEqual(session.messages, messages);
});

test("project agent profiles extend the built-in primary and explore profiles", () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-agent-"));
  mkdirSync(join(workspace, ".khazai", "agents"), { recursive: true });
  writeFileSync(join(workspace, ".khazai", "agents", "review.md"), [
    "---",
    "name: review",
    "role: primary",
    "description: Review changes",
    "tools: [read, glob, grep]",
    "---",
    "Inspect the patch and report risks.",
  ].join("\n"));
  const profiles = loadAgentProfiles(workspace);
  assert.equal(profiles.get("build").role, "primary");
  assert.equal(profiles.get("explore").role, "subagent");
  assert.deepEqual(profiles.get("review").tools, ["read", "glob", "grep"]);
});
