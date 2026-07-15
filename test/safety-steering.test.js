import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, streamDisposition } from "../app/agent.js";
import { Registry } from "../app/registry.js";
import { fallbackIntentContract } from "../app/intent-resolver.js";
import { editTool, writeTool } from "../tools/file.js";
import { isInternalAgentFailure } from "../ui/session.js";

function chatFrom(responses) {
  return async (_messages, options) => {
    const response = responses.shift();
    options.onToken?.(response);
    return response;
  };
}

test("modification intent redirects existing-file rewrite to a targeted edit and continues", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-patch-"));
  writeFileSync(join(workspace, "app.js"), "export const value = 1;\n");
  const edits = [];
  const registry = new Registry();
  registry.register({ name: "write", description: "write", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }, async execute() { throw new Error("rewrite must not execute"); } });
  registry.register({ name: "edit", description: "edit", parameters: { type: "object", properties: { path: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" } }, required: ["path", "oldString", "newString"] }, async execute(args) { edits.push(args); writeFileSync(args.path, readFileSync(args.path, "utf8").replace(args.oldString, args.newString)); return `Edited ${args.path}`; } });
  const agent = new Agent(registry, {
    workspace,
    intentResolver: async ({ input }) => fallbackIntentContract(input),
    chat: chatFrom([
      JSON.stringify({ tool: "write", args: { path: "app.js", content: "export const value = 2;\n" } }),
      JSON.stringify({ tool: "edit", args: { path: "app.js", oldString: "value = 1", newString: "value = 2" } }),
      "Fixed app.js.",
    ]),
  });
  const events = [];
  for await (const event of agent.loop("fix app.js using a patch; do not rewrite it")) events.push(event);
  rmSync(workspace, { recursive: true, force: true });

  assert.equal(agent._taskContract.category, "MODIFICATION");
  assert.equal(events.filter(event => event.type === "steering").length, 1);
  assert.deepEqual(events.filter(event => event.type === "tool-call").map(event => event.tool), ["edit"]);
  assert.equal(edits.length, 1);
  assert.equal(events.some(event => event.type === "error"), false);
  assert.equal(events.some(event => /read-only|workspace changes|BLOCKED|Denied/i.test(event.content || "")), false);
});

test("read-only mistake becomes invisible steering instead of a hard blocker", async () => {
  let writes = 0;
  const registry = new Registry();
  registry.register({ name: "write", description: "write", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }, async execute() { writes++; return "Written"; } });
  const agent = new Agent(registry, {
    workspace: "/tmp/khazai-read-only-steering",
    intentResolver: async ({ input }) => fallbackIntentContract(input),
    chat: chatFrom([
      JSON.stringify({ tool: "write", args: { path: "note.txt", content: "no" } }),
      "This is an explanation.",
    ]),
  });
  const events = [];
  for await (const event of agent.loop("What does this tool do?")) events.push(event);

  assert.equal(writes, 0);
  assert.equal(events.some(event => event.type === "steering"), true);
  assert.equal(events.some(event => event.type === "error"), false);
  assert.match(events.find(event => event.type === "stream")?.token || "", /explanation/i);
});

test("file tools refuse overwriting an existing file or replacing its whole source", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-file-guard-"));
  const path = join(workspace, "app.js");
  const source = "export function keep() { return 1; }\nexport function fix() { return 2; }\n";
  writeFileSync(path, source);
  const overwrite = await writeTool.execute({ path, content: "export const replacement = true;", _agentWorkspace: workspace });
  const broad = await editTool.execute({ path, oldString: source, newString: "export const replacement = true;", _agentWorkspace: workspace });
  rmSync(workspace, { recursive: true, force: true });

  assert.equal(overwrite.needsSteering, true);
  assert.equal(broad.needsSteering, true);
});

test("provider parser failure stays internal while an active plan recovers", async () => {
  const contexts = [];
  const registry = new Registry();
  registry.register({ name: "write", description: "write", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }, async execute(args) { return `Written ${args.path}`; } });
  const responses = [
    "[ ] Implement the requested change",
    "I couldn't parse the response. Try rephrasing your request more clearly.",
    JSON.stringify({ tool: "write", args: { path: "new.js", content: "export const ok = true;\n" } }),
    "Completed the requested change.",
  ];
  const agent = new Agent(registry, {
    workspace: "/tmp/khazai-parser-recovery",
    intentResolver: async () => ({ intent: "change", category: "MODIFICATION", operation: "modify", requiresPlan: true, requiredEvidence: ["mutation"], modifiesFiles: true, createNewFiles: true }),
    chat: async (messages, options) => {
      contexts.push(messages.map(message => message.content).join("\n"));
      const response = responses.shift();
      options.onToken?.(response);
      return response;
    },
  });
  const events = [];
  for await (const event of agent.loop("Fix new.js")) events.push(event);

  assert.equal(streamDisposition("I couldn't parse the response."), "structured");
  assert.equal(isInternalAgentFailure("I couldn't parse the response. Try rephrasing."), true);
  assert.equal(events.some(event => event.type === "error"), false);
  assert.equal(events.some(event => /couldn't parse|rephrasing/i.test(event.content || "")), false);
  assert.deepEqual(events.filter(event => event.type === "tool-call").map(event => event.tool), ["write"]);
  assert.equal(events.some(event => event.type === "plan-update" && event.status === "failed"), false);
  assert.match(contexts[2], /previous provider response was not usable/i);
});

test("completion gaps steer a modification internally and never become normal UI output", async () => {
  const contexts = [];
  const registry = new Registry();
  registry.register({
    name: "write",
    description: "write",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    async execute(args) { return `Written ${args.path}`; },
  });
  const responses = [
    "The change is complete.",
    JSON.stringify({ tool: "write", args: { path: "new.js", content: "export const fixed = true;\n" } }),
    "The targeted change is complete.",
  ];
  const agent = new Agent(registry, {
    workspace: "/tmp/khazai-completion-steering",
    intentResolver: async () => ({ intent: "change", category: "MODIFICATION", operation: "modify", requiredEvidence: ["mutation"], modifiesFiles: true, createNewFiles: true }),
    chat: async (messages, options) => {
      contexts.push(messages.map(message => message.content).join("\n"));
      const response = responses.shift();
      options.onToken?.(response);
      return response;
    },
  });
  const events = [];
  for await (const event of agent.loop("fix new.js")) events.push(event);

  const userVisible = events
    .filter(event => ["answer", "error", "stream", "tool-result"].includes(event.type))
    .map(event => event.content || event.token || event.result || "")
    .join("\n");
  assert.equal(events.some(event => event.type === "steering"), true);
  assert.deepEqual(events.filter(event => event.type === "tool-call").map(event => event.tool), ["write"]);
  assert.doesNotMatch(userVisible, /missing evidence|required execution evidence|successful workspace change/i);
  assert.equal(contexts.some(context => /Missing evidence|required execution evidence|successful workspace change/i.test(context)), false);
  assert.match(contexts[1], /Recommended action: inspect the target and apply a minimal targeted edit/);
});

test("legacy guard text is converted to internal steering instead of user-facing output", async () => {
  const registry = new Registry();
  registry.register({ name: "bash", description: "shell", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }, async execute() { return "BLOCKED: internal guard detail"; } });
  registry.register({ name: "read", description: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, async execute() { return "Repository structure"; } });
  const responses = [
    JSON.stringify({ tool: "bash", args: { command: "ls" } }),
    JSON.stringify({ tool: "read", args: { path: "README.md" } }),
    "Inspection complete.",
  ];
  const agent = new Agent(registry, {
    workspace: "/tmp/legacy-guard-test",
    intentResolver: async () => ({ intent: "inspect", category: "INSPECTION", operation: "inspect_code", requiredEvidence: ["inspection"] }),
    chat: chatFrom(responses),
  });
  const events = [];
  for await (const event of agent.loop("inspect README.md")) events.push(event);
  const output = events.map(event => event.content || event.result || event.token || "").join("\n");
  assert.equal(events.some(event => event.type === "steering"), true);
  assert.doesNotMatch(output, /Stopped:|BLOCKED|Denied|Safety violation/i);
  assert.deepEqual(events.filter(event => event.type === "tool-call").map(event => event.tool), ["bash", "read"]);
});
