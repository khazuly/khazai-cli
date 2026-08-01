import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { Agent } from "../app/agent.js";
import { prepareInit, verifyInitTarget } from "../app/init.js";
import { Registry } from "../app/registry.js";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "khazai-init-"));
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "fixture-app",
    scripts: { test: "node --test", build: "node build.js" },
  }));
  writeFileSync(join(root, "README.md"), "# Fixture\n");
  return root;
}

function modificationIntent() {
  return async ({ input }) => ({
    intent: "change",
    category: "MODIFICATION",
    operation: "modify_code",
    requiredEvidence: ["mutation"],
    requiresPlan: false,
    raw: input,
  });
}

test("existing AGENTS.md stops initialization before a model task is created", () => {
  const root = workspace();
  const target = join(root, "AGENTS.md");
  writeFileSync(target, "# Repository Guidelines\n\nKeep this file.\n");

  const prepared = prepareInit(root);

  assert.equal(prepared.status, "exists");
  assert.equal(prepared.task, undefined);
  assert.equal(prepared.message, "AGENTS.md already exists in this workspace.");
  assert.equal(readFileSync(target, "utf8"), "# Repository Guidelines\n\nKeep this file.\n");
});

test("missing AGENTS.md creates one hidden task for the normal agent loop", async () => {
  const root = workspace();
  const target = join(root, "AGENTS.md");
  const prepared = prepareInit(root);
  const calls = [];
  const registry = new Registry();
  registry.register({
    name: "read",
    description: "Read a file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    async execute(args) {
      calls.push(["read", args.path]);
      return readFileSync(isAbsolute(args.path) ? args.path : join(root, args.path), "utf8");
    },
  });
  registry.register({
    name: "write",
    description: "Write a file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    async execute(args) {
      calls.push(["write", args.path]);
      writeFileSync(isAbsolute(args.path) ? args.path : join(root, args.path), args.content);
      return "Wrote AGENTS.md";
    },
  });
  const responses = [
    JSON.stringify({ tool: "read", args: { path: "package.json" }, id: "read-package" }),
    JSON.stringify({
      tool: "write",
      args: {
        path: "AGENTS.md",
        content: "# Repository Guidelines\n\n## Build and Test\n\nRun `npm test`.\n",
      },
      id: "write-agents",
    }),
    "Created the contributor guide.",
  ];
  const agent = new Agent(registry, {
    workspace: root,
    intentResolver: modificationIntent(),
    chat: async () => responses.shift(),
  });

  const events = [];
  for await (const event of agent.loop(prepared.task, undefined, {
    runId: "init-run",
    turnId: "init-turn",
    taskEpoch: 1,
  })) events.push(event);

  assert.equal(prepared.status, "ready");
  assert.match(prepared.task, /approximately 200–400 words/);
  assert.deepEqual(calls, [["read", join(root, "package.json")], ["write", target]]);
  assert.equal(existsSync(target), true);
  assert.equal(verifyInitTarget(root, target).ok, true);
  assert.ok(events.some(event => event.type === "tool-result" && event.tool === "write"));
});

test("verification rejects empty files, directories, and targets outside the workspace", () => {
  const root = workspace();
  const empty = join(root, "AGENTS.md");
  writeFileSync(empty, "");
  assert.equal(verifyInitTarget(root, empty).ok, false);

  const directory = join(root, "instructions");
  mkdirSync(directory);
  assert.equal(verifyInitTarget(root, directory).ok, false);

  const outside = join(mkdtempSync(join(tmpdir(), "khazai-init-outside-")), "AGENTS.md");
  writeFileSync(outside, "# External\n");
  assert.equal(verifyInitTarget(root, outside).ok, false);
});

test("reloading workspace instructions exposes a newly created AGENTS.md", async () => {
  const root = workspace();
  const agent = new Agent(new Registry(), { workspace: root });
  assert.doesNotMatch(agent._buildSystem(), /Use the repository verification script/);

  writeFileSync(join(root, "AGENTS.md"), "# Repository Guidelines\n\nUse the repository verification script.\n");
  await agent.reloadWorkspaceInstructions();

  assert.match(agent._buildSystem(), /Use the repository verification script/);
});
