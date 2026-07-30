import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  connectMcpServer,
  disconnectMcpServer,
  mcpCatalog,
  parseMcpPairs,
  removeManagedMcpServer,
  setMcpServerEnabled,
  validateMcpServerDraft,
} from "../app/mcp-control.js";
import { McpManager } from "../app/mcp.js";
import { removeMcpServer, saveMcpServer } from "../config/index.js";
import { manageMcpCommand } from "../ui/mcp-command.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-mcp.js");

function localConfig(enabled = false) {
  return {
    mcp: {
      local: {
        command: process.execPath,
        args: [fixture],
        enabled,
        tools: { hidden: false },
      },
    },
  };
}

test("MCP configuration saves definitions and removal tombstones securely", () => {
  const root = mkdtempSync(join(tmpdir(), "khazai-mcp-config-write-"));
  const path = join(root, "config.json");
  try {
    saveMcpServer("local", { type: "stdio", command: "node", enabled: true }, path);
    let saved = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(saved.mcp.local.command, "node");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    removeMcpServer("local", path);
    saved = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(saved.mcp.local, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP draft validation covers transports, uniqueness, executables, and pairs", () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-mcp-draft-"));
  try {
    const stdio = validateMcpServerDraft({
      id: "local",
      transport: "stdio",
      command: process.execPath,
      args: [fixture],
      enabled: true,
    }, workspace);
    assert.equal(stdio.command, process.execPath);
    assert.deepEqual(parseMcpPairs("TOKEN={env:TOKEN}, MODE=read", "Environment variables"), {
      TOKEN: "{env:TOKEN}",
      MODE: "read",
    });
    assert.equal(validateMcpServerDraft({
      id: "remote",
      transport: "http",
      url: "https://example.com/mcp",
    }, workspace).type, "http");
    assert.throws(() => validateMcpServerDraft({
      id: "local",
      transport: "stdio",
      command: process.execPath,
    }, workspace, { local: {} }), /already configured/);
    assert.throws(() => validateMcpServerDraft({
      id: "missing",
      transport: "stdio",
      command: "definitely-not-an-executable",
    }, workspace), /was not found/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("connect, catalog, stale-call rejection, and disconnect update one manager", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-mcp-control-"));
  const manager = new McpManager(workspace, localConfig(false));
  try {
    assert.deepEqual(await manager.refresh(), []);
    assert.equal(manager.status()[0].state, "disabled");
    const tools = await connectMcpServer(manager, "local");
    assert.deepEqual(tools.map(tool => tool.name), ["mcp__local__echo"]);
    assert.equal(manager.status()[0].state, "connected");
    assert.equal(manager.status()[0].pid > 0, true);
    const pid = manager.status()[0].pid;

    const resources = await mcpCatalog(manager, "resources", "local");
    const prompts = await mcpCatalog(manager, "prompts", "local");
    assert.equal(resources[0].items[0].uri, "file:///docs/readme.md");
    assert.equal(prompts[0].items[0].name, "review");

    const stale = await tools[0].execute({ value: "ignored" }, {
      runId: "old-run",
      turnId: "old-turn",
      isActiveRun: () => false,
    });
    assert.match(stale, /discarded/);

    assert.deepEqual(await disconnectMcpServer(manager, "local"), []);
    assert.equal(manager.status()[0].state, "disabled");
    assert.equal(manager.status()[0].pid, undefined);
    assert.throws(() => process.kill(pid, 0));
  } finally {
    await manager.shutdown();
    rmSync(workspace, { recursive: true, force: true });
  }
  assert.equal(existsSync(workspace), false);
});

test("enable, disable, and remove persist while refreshing registrations", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-mcp-persist-"));
  const configPath = join(workspace, ".khazai-ai.json");
  removeMcpServer("khazai-code", configPath);
  saveMcpServer("local", localConfig(false).mcp.local, configPath);
  const manager = new McpManager(workspace);
  try {
    assert.deepEqual(await manager.refresh(), []);
    const enabled = await setMcpServerEnabled(manager, "local", true);
    assert.deepEqual(enabled.map(tool => tool.name), ["mcp__local__echo"]);
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).mcp.local.enabled, true);
    const pid = manager.status()[0].pid;
    assert.deepEqual(await setMcpServerEnabled(manager, "local", false), []);
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).mcp.local.enabled, false);
    assert.throws(() => process.kill(pid, 0));
    await removeManagedMcpServer(manager, "local");
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).mcp.local, null);
    assert.equal(manager.status().length, 0);
  } finally {
    await manager.shutdown();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("MCP add wizard persists stdio and HTTP definitions in workspace config", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-mcp-wizard-"));
  const manager = {
    workspace,
    refresh: async () => [],
    status: () => [],
  };
  const responses = [];
  const runWizard = async answers => {
    const queue = [...answers];
    await manageMcpCommand("add", {
      manager,
      requestValue: async () => queue.shift() || "",
      respond: (type, content) => responses.push({ type, content }),
      syncTools() {},
    });
  };
  try {
    await runWizard(["local-test", "stdio", "Yes", process.execPath, "-", "Keep or skip"]);
    await runWizard(["remote-test", "http", "No", "https://example.com/mcp", "Keep or skip"]);
    const saved = JSON.parse(readFileSync(join(workspace, ".khazai-ai.json"), "utf8"));
    assert.equal(saved.mcp["local-test"].command, process.execPath);
    assert.equal(saved.mcp["local-test"].enabled, true);
    assert.equal(saved.mcp["remote-test"].url, "https://example.com/mcp");
    assert.equal(saved.mcp["remote-test"].enabled, false);
    assert.equal(responses.filter(item => item.type === "error").length, 0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
