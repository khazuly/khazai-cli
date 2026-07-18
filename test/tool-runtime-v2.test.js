import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../app/agent.js";
import { PermissionService } from "../app/permission.js";
import { Registry } from "../app/registry.js";
import { ToolLifecycle } from "../app/tool-lifecycle.js";
import { toProviderMessages } from "../lib/providers.js";
import { readTool } from "../tools/file.js";
import { applyPatchTool } from "../tools/patch.js";

test("native read-only tool batches preserve IDs and execute concurrently", async () => {
  const registry = new Registry();
  const started = [];
  for (const name of ["read", "grep"]) {
    registry.register({
      name,
      description: name,
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      async execute() {
        started.push({ name, at: Date.now() });
        await new Promise(resolve => setTimeout(resolve, 150));
        return `${name} result`;
      },
    });
  }
  const responses = [
    JSON.stringify([
      { tool: "read", args: { path: "a.js" }, id: "call-a" },
      { tool: "grep", args: { path: "." }, id: "call-b" },
    ]),
    "Inspection completed.",
  ];
  const agent = new Agent(registry, {
    workspace: mkdtempSync(join(tmpdir(), "khazai-batch-")),
    intentResolver: async () => ({
      intent: "inspect",
      category: "INSPECTION",
      operation: "inspect_code",
      requiredEvidence: ["inspection"],
      requiresPlan: false,
    }),
    chat: async (_messages, options) => {
      const response = responses.shift();
      options.onToken?.(response);
      return response;
    },
  });
  const events = [];
  for await (const event of agent.loop("inspect both files")) events.push(event);
  assert.ok(Math.abs(started[0].at - started[1].at) < 40);
  assert.deepEqual(events.filter(event => event.type === "tool-call").map(event => event.callId), ["call-a", "call-b"]);
  assert.deepEqual(events.filter(event => event.type === "tool-result").map(event => event.callId), ["call-a", "call-b"]);
});

test("apply_patch performs atomic add, update, move, delete, and rollback", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-patch-"));
  writeFileSync(join(workspace, "old.txt"), "alpha\n");
  let result = await applyPatchTool.execute({
    _agentWorkspace: workspace,
    patchText: [
      "*** Begin Patch",
      "*** Update File: old.txt",
      "*** Move to: moved.txt",
      "@@",
      "-alpha",
      "+beta",
      "*** Add File: added.txt",
      "+new",
      "*** End Patch",
    ].join("\n"),
  });
  assert.match(result, /^Applied patch/);
  assert.equal(existsSync(join(workspace, "old.txt")), false);
  assert.equal(readFileSync(join(workspace, "moved.txt"), "utf-8"), "beta\n");
  assert.equal(readFileSync(join(workspace, "added.txt"), "utf-8"), "new");

  result = await applyPatchTool.execute({
    _agentWorkspace: workspace,
    patchText: [
      "*** Begin Patch",
      "*** Delete File: added.txt",
      "*** Update File: missing.txt",
      "@@",
      "-x",
      "+y",
      "*** End Patch",
    ].join("\n"),
  });
  assert.match(result, /^Error:/);
  assert.equal(readFileSync(join(workspace, "added.txt"), "utf-8"), "new");
});

test("OpenCode-style edit permissions cover write, edit, and apply_patch", () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-edit-permission-"));
  const grouped = new PermissionService(workspace, { permission: { edit: "allow" } });
  assert.equal(grouped.evaluate("write", { path: "a.js" }).decision, "allow");
  assert.equal(grouped.evaluate("edit", { path: "a.js" }).decision, "allow");
  assert.equal(grouped.evaluate("apply_patch", {
    patchText: "*** Begin Patch\n*** Add File: a.js\n+x\n*** End Patch",
  }).decision, "allow");
  const migrated = new PermissionService(workspace, { permission: { write: "deny" } });
  assert.equal(migrated.evaluate("edit", { path: "a.js" }).decision, "deny");
});

test("permission rules use last match, agent precedence, home expansion, and auto mode", () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-rules-"));
  const service = new PermissionService(workspace, {
    permission: {
      bash: { "*": "ask", "git *": "allow", "git push *": "deny" },
      external_directory: { "~/trusted/**": "allow" },
    },
  }, {
    agentPermission: { bash: { "git status*": "deny" } },
    auto: true,
  });
  assert.equal(service.evaluate("bash", { command: "npm test" }).decision, "allow");
  assert.equal(service.evaluate("bash", { command: "git diff" }).decision, "allow");
  assert.equal(service.evaluate("bash", { command: "git push origin main" }).decision, "deny");
  assert.equal(service.evaluate("bash", { command: "git status" }).decision, "deny");
  assert.equal(
    service.evaluateExternalDirectory("read", { path: `${process.env.HOME}/trusted/file.txt` }).decision,
    "allow",
  );
  assert.equal(
    service.evaluateExternalDirectory("bash", { command: "cat /etc/passwd", workdir: workspace }).decision,
    "allow",
  );
});

test("external-directory approval is separate from normal read permission", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-workspace-"));
  const external = mkdtempSync(join(tmpdir(), "khazai-external-"));
  const path = join(external, "outside.txt");
  writeFileSync(path, "outside\n");

  const permissions = new PermissionService(workspace, { permission: { read: "allow" } });
  assert.equal(permissions.evaluate("read", { path }).decision, "allow");
  assert.equal(permissions.evaluateExternalDirectory({ path }).decision, "ask");
  await assert.rejects(
    () => readTool.execute({ path, _agentWorkspace: workspace }),
    /Workspace boundary violation/,
  );
  assert.match(
    await readTool.execute({ path, _agentWorkspace: workspace, _allowExternal: true }),
    /outside/,
  );
});

test("registry hooks wrap normalized tool execution in deterministic order", async () => {
  const registry = new Registry();
  const order = [];
  registry.on("tool.execute.before", async (_context, value) => {
    order.push("before-1");
    return { args: { ...value.args, value: 2 } };
  });
  registry.on("tool.execute.before", async (_context, value) => {
    order.push("before-2");
    return value;
  });
  registry.on("tool.execute.after", async (_context, output) => {
    order.push("after");
    return { ...output, output: `${output.output}!` };
  });
  const before = await registry.trigger("tool.execute.before", {}, { args: { value: 1 } });
  const after = await registry.trigger("tool.execute.after", {}, {
    title: "test", output: String(before.args.value), metadata: {}, attachments: [],
  });
  assert.deepEqual(order, ["before-1", "before-2", "after"]);
  assert.equal(after.output, "2!");
});

test("tool lifecycle persists state transitions and workspace patch parts", () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-lifecycle-"));
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace });
  writeFileSync(join(workspace, "tracked.txt"), "before\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: workspace });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: workspace });

  const lifecycle = new ToolLifecycle({ sessionId: "session", workspace });
  assert.equal(lifecycle.startStep("message").type, "snapshot");
  const part = lifecycle.pending({ callId: "call", tool: "write", input: { path: "tracked.txt" } });
  assert.equal(part.state.status, "pending");
  lifecycle.running(part);
  writeFileSync(join(workspace, "tracked.txt"), "after\n");
  lifecycle.completed(part, "Written");
  assert.equal(part.state.status, "completed");
  const finished = lifecycle.finishStep("tool-calls");
  assert.deepEqual(finished.find(item => item.type === "patch").files, ["tracked.txt"]);
  assert.equal(finished.at(-1).type, "step-finish");
});

test("synthetic history is sent to OpenAI-compatible providers as native tool messages", () => {
  const converted = toProviderMessages([
    { role: "user", content: "read" },
    { role: "assistant", content: JSON.stringify({ tool: "read", args: { path: "a.js" }, id: "call-1" }) },
    { role: "user", content: "---TOOL RESULT: read---\nsource" },
  ]);
  assert.equal(converted[1].tool_calls[0].id, "call-1");
  assert.deepEqual(converted[2], {
    role: "tool",
    tool_call_id: "call-1",
    name: "read",
    content: "source",
  });
});
