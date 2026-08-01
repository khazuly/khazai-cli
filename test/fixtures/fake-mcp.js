#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin });
let changed = false;

function send(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

input.on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    send(request.id, {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: "khazai-test-mcp", version: "1.0.0" },
      instructions: "Use echo when the user explicitly requests the local MCP server.",
    });
    return;
  }
  if (request.method === "tools/list") {
    if (process.env.KHAZAI_MCP_LIST_MARKER) {
      appendFileSync(process.env.KHAZAI_MCP_LIST_MARKER, "listed\n");
    }
    send(request.id, {
      tools: [
        {
          name: "echo",
          description: "Echo a value.",
          inputSchema: {
            type: "object",
            properties: {
              value: { type: "string" },
              mode: { type: "string" },
            },
          },
        },
        {
          name: "hidden",
          description: "Filtered test tool.",
          inputSchema: { type: "object", properties: {} },
        },
        ...(changed ? [{
          name: "changed",
          description: "Added after a tool-list notification.",
          inputSchema: { type: "object", properties: {} },
        }] : []),
      ],
    });
    return;
  }
  if (request.method === "tools/call") {
    if (process.env.KHAZAI_MCP_CALL_MARKER) {
      appendFileSync(process.env.KHAZAI_MCP_CALL_MARKER, "called\n");
    }
    if (request.params.arguments?.mode === "crash") process.exit(2);
    send(request.id, {
      content: [{ type: "text", text: `echo:${request.params.arguments?.value || ""}` }],
    });
    if (request.params.arguments?.mode === "change-tools") {
      changed = true;
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n`);
    }
    return;
  }
  if (request.method === "resources/list") {
    send(request.id, {
      resources: [{ uri: "file:///docs/readme.md", name: "Readme", description: "Project documentation." }],
    });
    return;
  }
  if (request.method === "prompts/list") {
    send(request.id, {
      prompts: [{ name: "review", description: "Review the current change." }],
    });
  }
});
