import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProviderCredential, saveProviderCredential } from "../lib/auth.js";
import { OpenAICompatibleProvider } from "../lib/providers.js";
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
