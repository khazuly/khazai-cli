import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  McpManager,
  normalizeMcpResult,
  resolveMcpDefinitions,
} from "../app/mcp.js";
import { Agent } from "../app/agent.js";
import { getAgentProfile } from "../app/agent-profiles.js";
import { PermissionService } from "../app/permission.js";
import { Registry } from "../app/registry.js";
import {
  getCredential,
  removeCredential,
  saveCredential,
} from "../lib/auth.js";
import { COMMANDS } from "../ui/commands.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-mcp.js");

function config(extra = {}) {
  return {
    mcp: {
      local: {
        command: process.execPath,
        args: [fixture],
        tools: { hidden: false },
        ...extra,
      },
    },
  };
}

test("MCP stdio discovery exposes native filtered tools and cleans up its process", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-mcp-"));
  const manager = new McpManager(workspace, config());
  let pid;
  try {
    const tools = await manager.refresh();
    assert.deepEqual(tools.map(tool => tool.name), ["mcp__local__echo"]);
    assert.equal(tools[0].parameters.properties.value.type, "string");
    assert.equal(await tools[0].execute({ value: "hello" }), "echo:hello");
    const status = manager.status()[0];
    assert.equal(status.state, "connected");
    assert.equal(status.toolCount, 1);
    assert.ok(status.pid > 0);
    pid = status.pid;
  } finally {
    await manager.shutdown();
  }
  assert.throws(() => process.kill(pid, 0));
});

test("MCP never reports connected without an enabled tool definition", async () => {
  const manager = new McpManager(mkdtempSync(join(tmpdir(), "khazai-mcp-empty-")), config({
    tools: { "*": false },
  }));
  try {
    assert.deepEqual(await manager.refresh(), []);
    assert.equal(manager.status()[0].state, "error");
    assert.match(manager.status()[0].error, /no enabled tools/i);
  } finally {
    await manager.shutdown();
  }
});

test("MCP Streamable HTTP discovery and calls use configured headers", async () => {
  let observedHeader = "";
  let toolListCalls = 0;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      observedHeader = request.headers.authorization || "";
      const body = Buffer.concat(chunks).toString("utf-8");
      if (!body) {
        response.writeHead(405).end();
        return;
      }
      const message = JSON.parse(body);
      if (!Object.hasOwn(message, "id")) {
        response.writeHead(202).end();
        return;
      }
      let result;
      if (message.method === "initialize") {
        result = {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "http-test", version: "1.0.0" },
        };
      } else if (message.method === "tools/list") {
        toolListCalls++;
        result = {
          tools: [{
            name: "ping",
            description: "Ping the server.",
            inputSchema: { type: "object", properties: {} },
          }],
        };
      } else {
        result = { content: [{ type: "text", text: "pong" }] };
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const manager = new McpManager(mkdtempSync(join(tmpdir(), "khazai-mcp-http-")), {
    mcp: {
      remote: {
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { Authorization: "Bearer test-mcp-header-value" },
      },
    },
  });
  try {
    const [tool] = await manager.refresh();
    assert.equal(tool.name, "mcp__remote__ping");
    assert.equal((await manager.connections[0].discover())[0].name, "ping");
    assert.equal(toolListCalls, 1);
    assert.equal(await tool.execute({}), "pong");
    assert.equal(observedHeader, "Bearer test-mcp-header-value");
  } finally {
    await manager.shutdown();
    await new Promise(resolve => server.close(resolve));
  }
});

test("MCP tools and instructions reach the provider and continue exactly once", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-mcp-agent-"));
  const manager = new McpManager(workspace, config());
  try {
    const [mcpTool] = await manager.refresh();
    const registry = new Registry().register(mcpTool);
    let requests = 0;
    let finalMessages = [];
    const agent = new Agent(registry, {
      workspace,
      chat: async (messages, options) => {
        requests++;
        assert.equal(options.tools.filter(tool => tool.function.name === mcpTool.name).length, 1);
        assert.match(messages[0].content, /Use echo when the user explicitly requests/);
        if (requests === 1) {
          return "I can answer without the MCP server.";
        }
        if (requests === 2) {
          assert.match(messages.find(message => /MCP CORRECTION/.test(String(message.content)))?.content || "", /Use the required MCP tool before answering/);
          return JSON.stringify({ tool: mcpTool.name, args: { value: "live" }, id: "mcp-call-1" });
        }
        finalMessages = messages;
        return "MCP result received.";
      },
    });
    const events = [];
    for await (const event of agent.loop("Use the local MCP echo tool")) events.push(event);
    assert.equal(requests, 3);
    const results = finalMessages.filter(message => message.role === "tool" && message.tool_call_id === "mcp-call-1");
    assert.equal(results.length, 1, JSON.stringify(finalMessages));
    assert.match(results[0].content, /echo:live/);
    assert.equal(
      events.filter(event => event.type === "tool-result" && event.tool === mcpTool.name).length,
      1,
      JSON.stringify(events.map(event => [event.type, event.tool, event.content])),
    );
    assert.match(events.filter(event => event.type === "stream").map(event => event.token).join(""), /MCP result received/);
  } finally {
    await manager.shutdown();
  }
});

test("MCP tool-list notifications refresh one live connection without respawning it", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-mcp-list-change-"));
  const marker = join(workspace, "lists.log");
  const manager = new McpManager(workspace, config({ env: { KHAZAI_MCP_LIST_MARKER: marker } }));
  let notifiedTools = [];
  const unsubscribe = manager.subscribe(tools => { notifiedTools = tools; });
  try {
    const [tool] = await manager.refresh();
    const pid = manager.status()[0].pid;
    await tool.execute({ mode: "change-tools" });
    const started = Date.now();
    while (!manager.tools().some(entry => entry.name === "mcp__local__changed")) {
      if (Date.now() - started > 2_000) assert.fail("MCP tool cache did not refresh");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(manager.status()[0].pid, pid);
    assert.ok(notifiedTools.some(entry => entry.name === "mcp__local__changed"));
    assert.equal(readFileSync(marker, "utf-8"), "listed\nlisted\n");
  } finally {
    unsubscribe();
    await manager.shutdown();
  }
});

test("MCP tool calls are not retried after a transport failure", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-mcp-no-retry-"));
  const marker = join(workspace, "calls.log");
  const manager = new McpManager(workspace, config({
    env: { KHAZAI_MCP_CALL_MARKER: marker },
    callTimeout: 1_000,
  }));
  try {
    const [tool] = await manager.refresh();
    assert.match(await tool.execute({ mode: "crash" }), /^Error: MCP tool call failed:/);
    assert.equal(readFileSync(marker, "utf-8"), "called\n");
    assert.equal(manager.status()[0].state, "error");
  } finally {
    await manager.shutdown();
  }
});

test("MCP config enforces secure remote URLs, workspace cwd, expansion, and disabled state", () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-mcp-config-"));
  process.env.KHAZAI_MCP_HEADER = "header-value";
  try {
    const resolved = resolveMcpDefinitions(workspace, {
      mcp: {
        remote: {
          url: "https://example.com/mcp",
          headers: { "X-Test": "{env:KHAZAI_MCP_HEADER}" },
        },
        insecure: { url: "http://example.com/mcp" },
        escape: { command: "node", cwd: ".." },
        off: { command: "node", enabled: false },
      },
    });
    assert.equal(resolved.definitions.find(item => item.id === "remote").headers["X-Test"], "header-value");
    assert.equal(resolved.definitions.find(item => item.id === "off").enabled, false);
    assert.deepEqual(resolved.errors.map(item => item.id).sort(), ["escape", "insecure"]);
    assert.ok(resolved.errors.every(item => !item.error.includes("header-value")));
  } finally {
    delete process.env.KHAZAI_MCP_HEADER;
  }
});

test("MCP definitions accept OpenCode local server format", () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-opencode-mcp-"));
  const { definitions, errors } = resolveMcpDefinitions(workspace, {
    mcp: {
      opencode: {
        type: "local",
        command: [process.execPath, fixture],
        environment: { OPENCODE_MCP_VALUE: "available" },
        timeout: 750,
      },
    },
  });
  assert.deepEqual(errors, []);
  assert.equal(definitions[0].command, process.execPath);
  assert.deepEqual(definitions[0].args, [fixture]);
  assert.equal(definitions[0].env.OPENCODE_MCP_VALUE, "available");
  assert.equal(definitions[0].discoveryTimeout, 750);
});

test("built-in code intelligence resolves as a workspace-scoped stdio server", () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-code-mcp-config-"));
  process.env.KHAZAI_CODE_MCP_ENTRY = fixture;
  try {
    const { definitions, errors } = resolveMcpDefinitions(workspace, {
      mcp: { "khazai-code": { type: "builtin", builtin: "code" } },
    });
    assert.deepEqual(errors, []);
    assert.equal(definitions[0].command, process.execPath);
    assert.deepEqual(definitions[0].args, [fixture, "--workspace", workspace]);
    assert.equal(definitions[0].cwd, workspace);
  } finally {
    delete process.env.KHAZAI_CODE_MCP_ENTRY;
  }
});

test("MCP results redact secrets, retain text layout, cap output, and omit binary bodies", () => {
  const secret = "mcp-secret-value";
  const output = normalizeMcpResult({
    content: [
      { type: "text", text: `first\nsecond ${secret}` },
      { type: "image", mimeType: "image/png", data: Buffer.alloc(12).toString("base64") },
    ],
  }, [secret]);
  assert.match(output, /first\nsecond \[REDACTED\]/);
  assert.match(output, /\[Image: image\/png, 12 bytes\]/);
  assert.equal(output.includes(Buffer.alloc(12).toString("base64")), false);

  const capped = normalizeMcpResult({ content: [{ type: "text", text: "x".repeat(110 * 1024) }] });
  assert.match(capped, /\[Output truncated at 100 KiB\]$/);
  assert.ok(Buffer.byteLength(capped) < 101 * 1024);
});

test("MCP permissions, profile wildcard selection, commands, and credentials use native contracts", () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-mcp-contract-"));
  const permissions = new PermissionService(workspace, { permission: {} });
  assert.equal(permissions.evaluate("mcp__github__create_issue", {}).decision, "allow");
  assert.equal(new PermissionService(workspace, {
    permission: { "mcp__github__*": "allow", mcp__github__delete_issue: "deny" },
  }).evaluate("mcp__github__list_issues", {}).decision, "allow");
  assert.equal(new PermissionService(workspace, {
    permission: { "mcp__github__*": "allow", mcp__github__delete_issue: "deny" },
  }).evaluate("mcp__github__delete_issue", {}).decision, "deny");

  const registry = new Registry();
  registry.register({ name: "read" });
  registry.register({ name: "mcp__local__echo" });
  assert.deepEqual(registry.subset(getAgentProfile(workspace, "plan").tools).list().map(tool => tool.name), [
    "read",
    "mcp__local__echo",
  ]);
  assert.equal(getAgentProfile(workspace, "explore").tools.includes("mcp_*"), false);
  assert.ok(COMMANDS.some(command => command.name === "/mcp"));

  const authPath = join(workspace, "auth.json");
  saveCredential("mcp:remote", "secret", authPath);
  assert.equal(getCredential("mcp:remote", null, authPath), "secret");
  assert.equal(statSync(authPath).mode & 0o777, 0o600);
  assert.equal(removeCredential("mcp:remote", authPath), true);
  assert.equal(getCredential("mcp:remote", null, authPath), "");
  assert.equal(existsSync(authPath), true);
});
