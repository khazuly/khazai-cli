import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../app/registry.js";
import { ToolLifecycle } from "../app/tool-lifecycle.js";
import { PermissionService } from "../app/permission.js";
import { ToolExecutor } from "../app/tool-executor.js";
import { handlePermissionCommand } from "../ui/session-commands.js";

function workspaceDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function storePath(workspace) {
  return join(workspace, ".permissions-test.json");
}

function writeRegistry() {
  const registry = new Registry();
  registry.register({
    name: "write",
    description: "Write",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    execute: () => "written",
  });
  return registry;
}

async function runWrite(workspace, path, handler, options = {}) {
  const permissions = new PermissionService(workspace, { permission: { edit: "ask" } }, {
    storePath: storePath(workspace),
    ...options,
  });
  const executor = new ToolExecutor({
    registry: writeRegistry(),
    lifecycle: new ToolLifecycle({ sessionId: options.sessionId || "perm-test", workspace }),
    permissionService: permissions,
    permissionHandler: handler,
    workspace,
    sessionId: options.sessionId || "perm-test",
  });
  const events = [];
  for await (const event of executor.execute({ name: "write", args: { path }, id: options.callId || "write-call" })) {
    events.push(event);
  }
  return { events, permissions };
}

test("Always allow this path persists and suppresses future prompts across service instances", async () => {
  const workspace = workspaceDir("khazai-persist-path-");
  const target = join(workspace, "src", "index.js");
  const first = await runWrite(workspace, target, async () => "Always allow this path");
  assert.equal(first.events.filter(event => event.type === "permission").length, 1);

  const second = await runWrite(workspace, target, async () => "Reject");
  assert.equal(second.events.some(event => event.type === "permission"), false);
  const result = second.events.find(event => event.type === "execution-result");
  assert.equal(result.failed, false);
  assert.equal(second.permissions.permissionState().rules.length, 1);
});

test("persisted rule survives restart, session resume, and /new in the same workspace", async () => {
  const workspace = workspaceDir("khazai-persist-restart-");
  const target = join(workspace, "src", "index.js");
  await runWrite(workspace, target, async () => "Always allow this path");

  const resumed = await runWrite(workspace, target, async () => "Reject", { sessionId: "resumed-session" });
  assert.equal(resumed.events.some(event => event.type === "permission"), false);

  const freshNew = await runWrite(workspace, target, async () => "Reject", { sessionId: "new-session" });
  assert.equal(freshNew.events.some(event => event.type === "permission"), false);
  assert.equal(freshNew.permissions.permissionState().rules.length, 1);
});

test("switching workspace loads a separate permission state", async () => {
  const workspaceA = workspaceDir("khazai-persist-ws-a-");
  const workspaceB = workspaceDir("khazai-persist-ws-b-");
  const target = join(workspaceA, "src", "index.js");
  await runWrite(workspaceA, target, async () => "Always allow this path");

  const other = await runWrite(workspaceB, join(workspaceB, "src", "index.js"), async () => "Reject");
  assert.equal(other.events.filter(event => event.type === "permission").length, 1);
  assert.equal(other.permissions.permissionState().rules.length, 0);
});

test("allow once never persists a rule", async () => {
  const workspace = workspaceDir("khazai-persist-once-");
  const target = join(workspace, "src", "index.js");
  const first = await runWrite(workspace, target, async () => "Allow once");
  assert.equal(first.permissions.permissionState().rules.length, 0);
  const second = await runWrite(workspace, target, async () => "Reject");
  assert.equal(second.events.filter(event => event.type === "permission").length, 1);
});

test("allow-all enters yolo mode for approval-required actions", async () => {
  const workspace = workspaceDir("khazai-allow-all-");
  const permissions = new PermissionService(workspace, {
    permission: { edit: "ask", bash: { "*": "ask" } },
  }, { storePath: storePath(workspace) });
  await permissions.setAllowAll(true);
  assert.equal(permissions.permissionState().allowAll, true);

  const outside = mkdtempSync(join(tmpdir(), "khazai-outside-"));
  const tools = [
    ["write", { path: join(workspace, "src", "index.js") }],
    ["bash", { command: "npm test", workdir: workspace }],
    ["read", { path: join(workspace, "README.md") }],
    ["glob", { pattern: "**/*.js" }],
  ];
  for (const [tool, args] of tools) {
    assert.equal(permissions.evaluate(tool, args).decision, "allow", `${tool} inside workspace`);
  }
  assert.equal(
    permissions.evaluateExternalDirectory("read", { path: join(outside, "file.txt") }).decision,
    "allow",
  );
  assert.equal(permissions.evaluateExternalDirectory("write", { path: join(outside, "file.txt") }).decision, "allow");

  const events = [];
  const executor = new ToolExecutor({
    registry: writeRegistry(),
    lifecycle: new ToolLifecycle({ sessionId: "allow-all-external", workspace }),
    permissionService: permissions,
    permissionHandler: async () => "Reject",
    workspace,
    sessionId: "allow-all-external",
  });
  for await (const event of executor.execute({
    name: "write",
    args: { path: join(outside, "file.txt") },
    id: "external-write",
  })) {
    events.push(event);
  }
  assert.equal(events.some(event => event.type === "permission"), false);
  assert.equal(events.find(event => event.type === "execution-result").failed, false);
  const reloaded = new PermissionService(workspace, { permission: { edit: "ask" } }, {
    storePath: storePath(workspace),
  });
  assert.equal(reloaded.evaluateExternalDirectory("read", { path: join(outside, "file.txt") }).decision, "allow");
});

test("disabling allow-all preserves individual rules", async () => {
  const workspace = workspaceDir("khazai-allow-all-off-");
  const target = join(workspace, "src", "index.js");
  const permissions = new PermissionService(workspace, { permission: { edit: "ask" } }, {
    storePath: storePath(workspace),
  });
  await permissions.allowAlways("edit", target);
  await permissions.setAllowAll(true);
  await permissions.setAllowAll(false);

  const state = permissions.permissionState();
  assert.equal(state.allowAll, false);
  assert.equal(state.rules.length, 1);
  assert.equal(permissions.evaluate("write", { path: target }).decision, "allow");
  assert.equal(permissions.evaluate("write", { path: join(workspace, "other.js") }).decision, "ask");
});

test("resetting workspace permissions restores approval requests", async () => {
  const workspace = workspaceDir("khazai-persist-reset-");
  const target = join(workspace, "src", "index.js");
  const permissions = new PermissionService(workspace, { permission: { edit: "ask" } }, {
    storePath: storePath(workspace),
  });
  await permissions.allowAlways("edit", target);
  await permissions.setAllowAll(true);
  await permissions.resetPermissions();

  const state = permissions.permissionState();
  assert.equal(state.allowAll, false);
  assert.deepEqual(state.rules, []);
  assert.equal(permissions.evaluate("write", { path: target }).decision, "ask");
  const reloaded = new PermissionService(workspace, { permission: { edit: "ask" } }, {
    storePath: storePath(workspace),
  });
  assert.equal(reloaded.permissionState().rules.length, 0);
});

test("directory permission covers descendants but not similar or sibling paths", async () => {
  const base = workspaceDir("khazai-prefix-root-");
  const workspace = join(base, "khazai-cli");
  mkdirSync(workspace, { recursive: true });
  const sibling = join(base, "khazai-cli-ui");
  mkdirSync(sibling, { recursive: true });
  const ui = join(workspace, "ui");
  mkdirSync(ui, { recursive: true });

  const permissions = new PermissionService(workspace, { permission: { read: "ask" } }, {
    storePath: storePath(workspace),
  });
  await permissions.allowAlways("read", ui);

  assert.equal(permissions.evaluate("read", { path: join(ui, "session.js") }).decision, "allow");
  assert.equal(permissions.evaluate("read", { path: join(ui, "nested", "deep.js") }).decision, "allow");
  assert.equal(permissions.evaluate("read", { path: join(ui, "..", "ui", "session.js") }).decision, "allow");
  assert.equal(permissions.evaluate("read", { path: join(ui, "session.js") }).source, "persisted");
  assert.equal(permissions.evaluate("read", { path: sibling }).decision, "ask");
  assert.equal(permissions.evaluate("read", { path: join(base, "other-project", "ui") }).decision, "ask");
  assert.equal(permissions.evaluate("read", { path: join(workspace, "ui-backup") }).decision, "ask");
});

test("exact-file permission covers only that file", async () => {
  const workspace = workspaceDir("khazai-exact-file-");
  const file = join(workspace, "session.js");
  writeFileSync(file, "source");
  const permissions = new PermissionService(workspace, { permission: { read: "ask" } }, {
    storePath: storePath(workspace),
  });
  await permissions.allowAlways("read", file);
  assert.equal(permissions.evaluate("read", { path: file }).decision, "allow");
  assert.equal(permissions.evaluate("read", { path: join(workspace, "other.js") }).decision, "ask");
});

test("symlinked paths resolve to the canonical target", async () => {
  const workspace = workspaceDir("khazai-symlink-");
  const real = join(workspace, "real");
  mkdirSync(real, { recursive: true });
  const link = join(workspace, "link");
  symlinkSync(real, link);
  const permissions = new PermissionService(workspace, { permission: { read: "ask" } }, {
    storePath: storePath(workspace),
  });
  await permissions.allowAlways("read", join(link, "session.js"));
  assert.equal(permissions.evaluate("read", { path: join(real, "session.js") }).decision, "allow");
  const state = permissions.permissionState();
  assert.equal(state.rules[0].path, join(real, "session.js"));
});

test("concurrent permission writes preserve every valid rule", async () => {
  const workspace = workspaceDir("khazai-concurrent-");
  const permissions = new PermissionService(workspace, { permission: {} }, {
    storePath: storePath(workspace),
  });
  const targets = Array.from({ length: 40 }, (_, index) => join(workspace, `src`, `file-${index}.js`));
  await Promise.all(targets.map(target => permissions.allowAlways("edit", target)));
  const state = permissions.permissionState();
  assert.equal(state.rules.length, targets.length);
  const reloaded = new PermissionService(workspace, { permission: {} }, { storePath: storePath(workspace) });
  assert.equal(reloaded.permissionState().rules.length, targets.length);
});

test("corrupted or mismatched permission data fails safely without granting access", async () => {
  const workspace = workspaceDir("khazai-corrupt-");
  const store = storePath(workspace);
  writeFileSync(store, "{ allowAll: true, rules: [broken", "utf-8");
  const permissions = new PermissionService(workspace, { permission: { edit: "ask" } }, { storePath: store });
  assert.equal(permissions.permissionState().allowAll, false);
  assert.deepEqual(permissions.permissionState().rules, []);
  assert.equal(permissions.evaluate("write", { path: join(workspace, "src", "index.js") }).decision, "ask");

  const foreign = mkdtempSync(join(tmpdir(), "khazai-foreign-"));
  writeFileSync(store, JSON.stringify({
    version: 1,
    workspaceRoot: foreign,
    allowAll: true,
    revision: 1,
    rules: [{ id: "r1", action: "edit", path: join(workspace, "src"), scope: "directory", createdAt: "now" }],
  }), "utf-8");
  const mismatched = new PermissionService(workspace, { permission: { edit: "ask" } }, { storePath: store });
  assert.equal(mismatched.permissionState().allowAll, false);
  assert.equal(mismatched.evaluate("write", { path: join(workspace, "src", "index.js") }).decision, "ask");
});

test("/permissions list, revoke, and reset manage persisted rules", async () => {
  const workspace = workspaceDir("khazai-perm-command-");
  const target = join(workspace, "src", "index.js");
  const permissions = new PermissionService(workspace, { permission: {} }, { storePath: storePath(workspace) });
  await permissions.allowAlways("edit", target);
  const ruleId = permissions.permissionState().rules[0].id;
  const messages = [];
  const context = {
    appendArchived: message => messages.push(message),
    requestValue: async (_question, _options, settings) => settings.values[1].value,
    workspacePath: workspace,
    permissionService: () => permissions,
  };

  await handlePermissionCommand("/permissions", "list", context);
  assert.match(messages.at(-1).content, /Allow-all\s+Disabled/);
  assert.match(messages.at(-1).content, new RegExp(ruleId));
  assert.match(messages.at(-1).content, /edit/);
  assert.doesNotMatch(messages.at(-1).content, /\.permissions-test\.json/);

  await handlePermissionCommand("/permissions", `revoke ${ruleId}`, context);
  assert.equal(permissions.permissionState().rules.length, 0);
  assert.match(messages.at(-1).content, /revoked/);

  await permissions.allowAlways("edit", target);
  await handlePermissionCommand("/permissions", "reset", context);
  assert.equal(permissions.permissionState().rules.length, 0);
  assert.equal(permissions.permissionState().allowAll, false);
  assert.match(messages.at(-1).content, /reset/);
});

test("/allow-all command requires confirmation before persisting", async () => {
  const workspace = workspaceDir("khazai-allow-all-confirm-");
  const permissions = new PermissionService(workspace, { permission: {} }, { storePath: storePath(workspace) });
  const messages = [];
  let offered = null;
  const context = {
    appendArchived: message => messages.push(message),
    requestValue: async (question, options, settings) => {
      offered = { question, options, settings };
      return settings.values[0].value;
    },
    workspacePath: workspace,
    permissionService: () => permissions,
  };

  await handlePermissionCommand("/allow-all", "", context);
  assert.equal(offered.question, "Enable allow-all for this workspace?");
  assert.equal(offered.options[0], "Cancel");
  assert.equal(offered.options[1], "Enable allow-all");
  assert.equal(permissions.permissionState().allowAll, false);
  assert.equal(messages.length, 0);

  context.requestValue = async (_question, _options, settings) => settings.values[1].value;
  await handlePermissionCommand("/allow-all", "", context);
  assert.equal(permissions.permissionState().allowAll, true);
  assert.equal(messages.at(-1).content, `Allow-all enabled for ${workspace}.`);
});

test("allow-all never overrides hard safety restrictions", async () => {
  const workspace = workspaceDir("khazai-allow-all-safety-");
  const permissions = new PermissionService(workspace, { permission: { bash: { "*": "ask" } } }, {
    storePath: storePath(workspace),
  });
  await permissions.setAllowAll(true);
  const denied = permissions.evaluate("write", { path: "/etc/khazai.conf" });
  assert.equal(denied.decision, "deny");
  assert.equal(denied.source, "safety");
  const sudo = permissions.evaluate("bash", { command: "sudo rm -rf /tmp/x" });
  assert.equal(sudo.decision, "deny");
});
