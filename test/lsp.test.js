import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "../app/agent.js";
import {
  LspManager,
  resolveLspDefinitions,
  shutdownAllLsp,
} from "../app/lsp.js";
import { PermissionService } from "../app/permission.js";
import { Registry } from "../app/registry.js";
import { createLspTool } from "../tools/lsp.js";
import { COMMANDS } from "../ui/commands.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-lsp.js");

function lspConfig() {
  return {
    lsp: {
      typescript: { disabled: true },
      python: { disabled: true },
      fake: {
        command: [process.execPath, fixture],
        extensions: [".fake"],
      },
    },
  };
}

test("LSP manager handles diagnostics, semantic queries, document sync, and shutdown", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-lsp-manager-"));
  const path = join(workspace, "sample.fake");
  writeFileSync(path, "BROKEN\n");
  const manager = new LspManager(workspace, lspConfig());
  let pid;
  try {
    assert.match(await manager.diagnostics("sample.fake"), /Fake semantic error/);
    assert.match(await manager.query({
      operation: "goToDefinition",
      path: "sample.fake",
      line: 1,
      character: 1,
    }), /sample\.fake:2:3/);
    assert.match(await manager.query({
      operation: "findReferences",
      path: "sample.fake",
      line: 1,
      character: 1,
    }), /sample\.fake:3:4/);
    assert.match(await manager.query({
      operation: "hover",
      path: "sample.fake",
      line: 1,
      character: 1,
    }), /FakeType/);
    assert.match(await manager.query({
      operation: "documentSymbol",
      path: "sample.fake",
    }), /FakeDocumentSymbol/);
    assert.match(await manager.query({
      operation: "workspaceSymbol",
      query: "Fake",
    }), /LSP symbols: none/);

    writeFileSync(path, "fixed\n");
    assert.match(await manager.diagnostics("sample.fake"), /No issues reported/);
    const running = manager.status().find(server => server.id === "fake");
    assert.equal(running.state, "running");
    assert.ok(running.pid > 0);
    pid = running.pid;
  } finally {
    await manager.shutdown();
  }
  assert.equal(manager.status().find(server => server.id === "fake").pid, null);
  assert.throws(() => process.kill(pid, 0));
});

test("LSP manager recovers once after a server process crashes", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-lsp-recovery-"));
  const marker = join(workspace, "crashed.marker");
  writeFileSync(join(workspace, "file.fake"), "ok\n");
  const config = lspConfig();
  config.lsp.fake.env = { KHAZAI_FAKE_LSP_CRASH_MARKER: marker };
  const manager = new LspManager(workspace, config);
  try {
    const result = await manager.query({
      operation: "hover",
      path: "file.fake",
      line: 1,
      character: 1,
    });
    assert.equal(existsSync(marker), true);
    assert.match(result, /RecoveredType/);
    assert.equal(manager.status().find(server => server.id === "fake").state, "running");
  } finally {
    await manager.shutdown();
  }
});

test("LSP requests time out cleanly after one bounded recovery attempt", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-lsp-timeout-"));
  writeFileSync(join(workspace, "file.fake"), "ok\n");
  const config = lspConfig();
  config.lsp.fake.env = { KHAZAI_FAKE_LSP_HANG_HOVER: "1" };
  const manager = new LspManager(workspace, config, { requestTimeoutMs: 100 });
  try {
    const result = await manager.query({
      operation: "hover",
      path: "file.fake",
      line: 1,
      character: 1,
    });
    assert.match(result, /timed out/);
  } finally {
    await manager.shutdown();
  }
});

test("LSP config is opt-in, supports presets/custom servers, and reports missing commands", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-lsp-config-"));
  writeFileSync(join(workspace, "file.fake"), "ok\n");
  assert.deepEqual(resolveLspDefinitions(workspace, { lsp: false }), []);
  const custom = resolveLspDefinitions(workspace, lspConfig());
  assert.deepEqual(custom.map(item => item.id), ["fake"]);
  assert.equal(custom[0].available, true);
  assert.equal(createLspTool(workspace, { lsp: false }), null);

  const missing = new LspManager(workspace, {
    lsp: {
      typescript: { disabled: true },
      python: { disabled: true },
      missing: { command: ["khazai-lsp-command-that-does-not-exist"], extensions: [".fake"] },
    },
  });
  assert.match(await missing.diagnostics("file.fake"), /not installed or not executable/);
});

test("LSP permission defaults to allow and supports explicit ask/deny policy", () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-lsp-permission-"));
  assert.equal(new PermissionService(workspace, { permission: {} }).evaluate("lsp", {}).decision, "allow");
  assert.equal(new PermissionService(workspace, { permission: { lsp: "ask" } }).evaluate("lsp", {}).decision, "ask");
  assert.equal(new PermissionService(workspace, { permission: { lsp: "deny" } }).evaluate("lsp", {}).decision, "deny");
  assert.ok(COMMANDS.some(command => command.name === "/lsp"));
  assert.equal(COMMANDS.some(command => /opencode/i.test(command.description)), false);
});

test("successful writes do not inject hidden LSP diagnostics into tool results", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-lsp-agent-"));
  const registry = new Registry();
  registry.register({
    name: "write",
    description: "Create a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
    async execute(args) {
      writeFileSync(args.path, args.content);
      return `Written ${args.path}`;
    },
  });
  registry.register(createLspTool(workspace, lspConfig()));
  const responses = [
    JSON.stringify({ tool: "write", args: { path: "created.fake", content: "BROKEN\n" } }),
    "Created the requested file.",
  ];
  const agent = new Agent(registry, {
    workspace,
    intentResolver: async () => ({
      intent: "change",
      category: "MODIFICATION",
      operation: "create",
      requiresPlan: false,
      requiredEvidence: ["mutation"],
      modifiesFiles: true,
      createNewFiles: true,
    }),
    chat: async (_messages, options) => {
      const response = responses.shift();
      options.onToken?.(response);
      return response;
    },
  });
  const events = [];
  try {
    for await (const event of agent.loop("create created.fake")) events.push(event);
    const result = events.find(event => event.type === "tool-result" && event.tool === "write");
    assert.match(result.result, /Written .*created\.fake$/);
    assert.doesNotMatch(result.result, /LSP diagnostics|Fake semantic error/);
  } finally {
    await shutdownAllLsp();
  }
});
