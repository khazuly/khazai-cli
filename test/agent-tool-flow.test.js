import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../app/agent.js";
import { Registry } from "../app/registry.js";
import { ShellScheduler } from "../app/shell-scheduler.js";
import { execAsync } from "../lib/exec-async.js";
import {
  parseTestReport,
  shellTimeoutMs,
  testExecutionProfile,
} from "../lib/shell-command-policy.js";
import { bashTool } from "../tools/shell.js";

function intent(kind = "answer") {
  return async ({ input }) => ({
    intent: kind,
    category: kind === "change" ? "MODIFICATION" : "ANSWER",
    operation: kind === "change" ? "modify_code" : "answer",
    requiredEvidence: kind === "change" ? ["mutation"] : [],
    requiresPlan: false,
    raw: input,
  });
}

function scripted(responses) {
  return async (_messages, options) => {
    const response = responses.shift();
    if (response === undefined) throw new Error("Unexpected extra model turn");
    options.onToken?.(response);
    return response;
  };
}

test("prose options remain model prose unless the question tool is called", async () => {
  let question;
  const agent = new Agent(new Registry(), {
    workspace: mkdtempSync(join(tmpdir(), "khazai-question-")),
    intentResolver: intent("change"),
    questionHandler: async value => {
      question = value;
      return value.options[0];
    },
    chat: scripted(["Are you sure you want to delete stock_manager.py?\n1. Yes, delete it\n2. No, cancel", "Cancelled."]),
  });
  const events = [];
  for await (const event of agent.loop("delete stock_manager.py")) events.push(event);
  assert.equal(question, undefined);
  assert.equal(events.filter(event => event.type === "question").length, 0);
  assert.match(events.filter(event => event.type === "stream").map(event => event.token).join(""), /Yes, delete it/);
});

test("repeated inspection calls remain under model control", async () => {
  const registry = new Registry();
  let executions = 0;
  registry.register({ name: "glob", description: "glob", parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] }, async execute() { executions++; return "Found 1:\na.js"; } });
  const calls = [JSON.stringify({ tool: "glob", args: { pattern: "*" } }), JSON.stringify({ tool: "glob", args: { pattern: "*" } }), "The workspace contains a.js."];
  const agent = new Agent(registry, { workspace: mkdtempSync(join(tmpdir(), "khazai-loop-cache-")), intentResolver: intent(), chat: scripted(calls) });
  const events = [];
  for await (const event of agent.loop("list the workspace files")) events.push(event);
  assert.equal(executions, 2);
  assert.equal(events.filter(event => event.type === "tool-call").length, 2);
  assert.match(events.filter(event => event.type === "stream").map(event => event.token).join(""), /a\.js/);
});

test("repeated read-only batches remain under model control", async () => {
  const registry = new Registry();
  const executions = { read: 0, glob: 0 };
  for (const name of ["read", "glob"]) registry.register({ name, description: name, parameters: { type: "object", properties: {} }, async execute() { executions[name]++; return name === "read" ? "source" : "Found 1:\na.js"; } });
  const read = { tool: "read", args: { path: "a.js" } };
  const glob = { tool: "glob", args: { pattern: "*" } };
  const agent = new Agent(registry, { workspace: mkdtempSync(join(tmpdir(), "khazai-batch-loop-cache-")), intentResolver: intent(), chat: scripted([JSON.stringify([read, glob]), JSON.stringify([read, glob]), "Inspection complete."]) });
  const events = [];
  for await (const event of agent.loop("inspect the workspace")) events.push(event);
  assert.deepEqual(executions, { read: 2, glob: 2 });
  assert.match(events.filter(event => event.type === "stream").map(event => event.token).join(""), /Inspection complete/);
});

test("alternating tool calls run until the model completes", async () => {
  const registry = new Registry();
  const executions = { read: 0, glob: 0, write: 0 };
  for (const name of ["read", "glob", "write"]) registry.register({ name, description: name, parameters: { type: "object", properties: {} }, async execute() { executions[name]++; return name === "read" ? "source" : name === "glob" ? "Found 1:\na.js" : "Written a.js"; } });
  const read = JSON.stringify({ tool: "read", args: { path: "a.js" } });
  const glob = JSON.stringify({ tool: "glob", args: { pattern: "*" } });
  const write = JSON.stringify({ tool: "write", args: { path: "a.js", content: "source" } });
  const agent = new Agent(registry, { workspace: mkdtempSync(join(tmpdir(), "khazai-alternating-loop-")), intentResolver: intent("change"), chat: scripted([read, glob, write, read, glob, write, read, glob, write, "Done."]) });
  const events = [];
  for await (const event of agent.loop("update a.js")) events.push(event);
  assert.deepEqual(executions, { read: 3, glob: 3, write: 3 });
  assert.match(events.filter(event => event.type === "stream").map(event => event.token).join(""), /Done/);
});

test("bang shell shortcut bypasses the model and uses the normal tool lifecycle", async () => {
  const registry = new Registry();
  registry.register(bashTool);
  let providerCalls = 0;
  const agent = new Agent(registry, { workspace: mkdtempSync(join(tmpdir(), "khazai-shell-shortcut-")), chat: async () => { providerCalls++; return "This must not be called."; } });
  const events = [];
  for await (const event of agent.loop("!printf shortcut-ok")) events.push(event);
  assert.equal(providerCalls, 0);
  assert.deepEqual(events.filter(event => event.type === "tool-call").map(event => event.tool), ["bash"]);
  assert.match(events.find(event => event.type === "tool-result")?.result || "", /shortcut-ok/);
});

test("successful identical shell commands reuse one execution until files change", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-shell-cache-"));
  const registry = new Registry();
  let executions = 0;
  registry.register({
    ...bashTool,
    async execute(args, context) {
      executions++;
      return bashTool.execute(args, context);
    },
  });
  registry.register({
    name: "write",
    description: "write",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    async execute() { return "Written 1 bytes to marker.txt"; },
  });
  const shell = id => JSON.stringify({ tool: "bash", id, args: { command: "printf verified" } });
  const write = JSON.stringify({ tool: "write", id: "write-1", args: { path: "marker.txt", content: "x" } });
  const agent = new Agent(registry, {
    workspace,
    intentResolver: intent("change"),
    chat: scripted([shell("shell-1"), shell("shell-2"), write, shell("shell-3"), "Done."]),
  });
  const events = [];
  for await (const event of agent.loop("verify, change, and verify again")) events.push(event);
  assert.equal(executions, 2);
  assert.equal(events.filter(event => event.type === "tool-call" && event.tool === "bash").length, 2);
});

test("failed identical targeted tests allow one justified retry", async () => {
  const registry = new Registry();
  let executions = 0;
  registry.register({
    ...bashTool,
    async execute() {
      executions++;
      return "Exit: -1\nTimed out after 60000ms";
    },
  });
  const call = (id, args = {}) => JSON.stringify({
    tool: "bash",
    id,
    args: { command: "node --test test/example.test.js", ...args },
  });
  const agent = new Agent(registry, {
    workspace: mkdtempSync(join(tmpdir(), "khazai-shell-retry-")),
    intentResolver: intent(),
    chat: scripted([
      call("shell-1"),
      call("shell-blocked"),
      call("shell-2", { timeout: 180, retryReason: "The first attempt timed out before the suite completed." }),
      call("shell-blocked-again", { timeout: 240, retryReason: "Retry again." }),
      "Verification remains blocked after two attempts.",
    ]),
  });
  for await (const _event of agent.loop("run the tests")) {}
  assert.equal(executions, 2);
});

test("full and targeted test commands receive distinct bounded timeouts", () => {
  const full = testExecutionProfile("npm test", process.cwd());
  const direct = testExecutionProfile("node --test test/*.test.js", process.cwd());
  const targeted = testExecutionProfile("node --test test/execution-policy.test.js", process.cwd());
  assert.deepEqual([full.scope, direct.scope, targeted.scope], ["full", "full", "targeted"]);
  assert.equal(full.testFileCount, 40);
  assert.equal(shellTimeoutMs("npm test", process.cwd(), 60), 120_000);
  assert.equal(shellTimeoutMs("node --test test/execution-policy.test.js", process.cwd()), 60_000);
});

test("shell pipelines preserve the failing command exit status", async () => {
  await assert.rejects(
    execAsync("sh -c 'exit 7' | tail -n 1", { pipefail: true }),
    error => error.status === 7,
  );
  const filtered = await bashTool.execute({ command: "node --test test/example.test.js | tail -n 1" });
  assert.match(filtered, /^Exit: 2/);
  assert.match(filtered, /can hide the test runner exit status/);
});

test("test reports preserve counts, duration, and the first failure", () => {
  const report = parseTestReport([
    "✖ rejects invalid input",
    "# tests 4",
    "# pass 3",
    "# fail 1",
    "# cancelled 0",
    "# duration_ms 1234.5",
  ].join("\n"));
  assert.deepEqual(report, {
    passed: 3,
    failed: 1,
    cancelled: 0,
    durationMs: 1234.5,
    firstFailure: "✖ rejects invalid input",
  });
});

test("full-suite timeouts require a cleanup change before another launch", () => {
  const scheduler = new ShellScheduler(process.cwd());
  const first = { id: "suite-1", name: "bash", args: { command: "npm test" } };
  scheduler.beginRun("run-1", "turn-1", 1);
  assert.equal(scheduler.reserve(first), null);
  assert.equal(scheduler.running(first), true);
  scheduler.complete(first, "Exit: -1\nTest suite timed out after 120s", true);
  const duplicate = scheduler.reserve({
    id: "suite-2",
    name: "bash",
    args: { command: "npm test", timeout: 180, retryReason: "Retry the suite." },
  });
  assert.match(duplicate.result, /requires a concrete cleanup change/);
  scheduler.complete({ name: "edit" }, "Edited test cleanup", false);
  assert.equal(scheduler.reserve({ id: "suite-3", name: "bash", args: { command: "npm test" } }), null);
});

test("verification commands cannot mutate Git state", async () => {
  const result = await bashTool.execute({ command: "git stash && npm test" });
  assert.match(result, /^Exit: 2/);
  assert.match(result, /Git working-tree mutation is not allowed/);
});
