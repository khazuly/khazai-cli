import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement as h } from "react";
import { render } from "ink";
import { Agent } from "../app/agent.js";
import {
  PLAN_ACTIONS,
  approvePlanMode,
  approvedPlanRequest,
  changedPlanFiles,
  cleanPlanOutput,
  createPlanModeState,
  finalizePlanMode,
  planScopeMatches,
  planToolIsReadOnly,
  recordPlanDecision,
  refreshPlanSnapshots,
} from "../app/plan-mode.js";
import { Registry } from "../app/registry.js";
import { normalizeQuestionRequest } from "../app/tool-executor.js";
import { ExecutionPolicy } from "../app/execution-policy.js";
import { PromptInput } from "../ui/components/prompt-input.js";
import { SessionFooter } from "../ui/components/session-footer.js";
import { renderComponent, stripAnsi, TerminalInput, TerminalOutput } from "./helpers/ink-render.js";

function scripted(responses) {
  return async (_messages, options) => {
    const response = responses.shift();
    if (response === undefined) throw new Error("Unexpected extra model turn");
    options.onToken?.(response);
    return response;
  };
}

test("Plan Mode preserves structured decisions and immutable approval scope", () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-plan-state-"));
  writeFileSync(join(workspace, "app.js"), "export const value = 1;\n");
  const scope = { sessionId: "session-1", runId: "run-1", turnId: "turn-1", taskEpoch: 3 };
  let plan = createPlanModeState({ objective: "Update context usage", ...scope });
  assert.equal(planScopeMatches(plan, scope), true);
  plan = recordPlanDecision(plan, {
    questionId: "usage-source",
    question: "How should usage be calculated?",
  }, {
    id: "provider-fallback",
    label: "Provider metadata with tokenizer fallback",
  });
  plan = finalizePlanMode(plan, {
    workspace,
    summary: "# Implementation Plan\n\nNo files have been modified.",
    relevantFiles: ["app.js"],
    steps: ["Update usage accounting", "Run targeted tests"],
  });
  const approved = approvePlanMode(plan);
  assert.equal(approved.status, "approved");
  assert.ok(approved.planRevision > 1);
  assert.equal(approved.decisions[0].optionId, "provider-fallback");
  assert.equal(approved.relevantFiles[0], "app.js");
  assert.equal(approvePlanMode(approved), null);
  assert.match(approvedPlanRequest(approved), /Provider metadata with tokenizer fallback/);
});

test("Plan approval exposes one bounded Build decision", () => {
  assert.deepEqual(PLAN_ACTIONS.map(action => action.label), [
    "Build this plan",
    "Continue planning",
    "Cancel",
  ]);
  assert.equal(PLAN_ACTIONS.filter(action => action.recommended).length, 1);
});

test("Plan output removes internal evidence and blocking bookkeeping", () => {
  assert.equal(cleanPlanOutput([
    "# Implementation Plan",
    "Evidence collected: read app.js",
    "Blocking: mutation is unavailable",
    "- Goal: update the runtime",
  ].join("\n")), "# Implementation Plan\n- Goal: update the runtime");
});

test("planning evidence never requires a workspace mutation", () => {
  const policy = new ExecutionPolicy({
    intent: "change",
    category: "MODIFICATION",
    requiredEvidence: ["inspection", "mutation", "validation"],
  }, { planning: true });
  policy.record("read", { path: "app.js" }, "source");
  assert.deepEqual(policy.completionGaps(), []);
});

test("Plan Mode Shell policy permits inspection and rejects indirect file creation", () => {
  assert.equal(planToolIsReadOnly({ name: "bash", args: { command: "git diff -- app.js" } }), true);
  assert.equal(planToolIsReadOnly({ name: "bash", args: { command: "rg plan . 2>/dev/null" } }), true);
  assert.equal(planToolIsReadOnly({ name: "bash", args: { command: "git diff > /tmp/plan.diff" } }), false);
  assert.equal(planToolIsReadOnly({ name: "bash", args: { command: "curl https://example.com -o /tmp/page" } }), false);
  assert.equal(planToolIsReadOnly(
    { name: "mcp__docs__search", args: {} },
    { mcp: { readOnly: true } },
  ), true);
  assert.equal(planToolIsReadOnly(
    { name: "mcp__repo__write", args: {} },
    { mcp: { readOnly: false } },
  ), false);
});

test("Plan Mode snapshots detect changes and support explicit revalidation", () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-plan-snapshot-"));
  const path = join(workspace, "session.js");
  writeFileSync(path, "before\n");
  const plan = finalizePlanMode(
    createPlanModeState({ objective: "Update session", runId: "r", turnId: "t", taskEpoch: 1 }),
    { workspace, summary: "Plan", relevantFiles: ["session.js"], steps: [] },
  );
  writeFileSync(path, "after\n");
  assert.deepEqual(changedPlanFiles(plan, workspace), ["session.js"]);
  assert.deepEqual(changedPlanFiles(refreshPlanSnapshots(plan, workspace), workspace), []);
});

test("structured Plan questions retain recommendations, descriptions, and custom input", () => {
  const question = normalizeQuestionRequest({
    questionId: "context-source",
    question: "How should context usage be calculated?",
    context: "Exact metadata is preferred when available.",
    options: [{
      id: "provider",
      label: "Provider metadata",
      description: "Use exact provider usage.",
      recommended: true,
    }],
    allowCustomAnswer: true,
  });
  assert.equal(question.options.length, 2);
  assert.equal(question.options[0].recommended, true);
  assert.equal(question.options[0].description, "Use exact provider usage.");
  assert.equal(question.options[1].custom, true);
});

test("Plan selections render recommendations and keep keyboard navigation visible", async () => {
  const stdout = new TerminalOutput(54, 18);
  const stdin = new TerminalInput();
  const selected = [];
  const options = Array.from({ length: 8 }, (_, index) => ({
    id: `option-${index + 1}`,
    label: `Choice ${index + 1}`,
    description: `Explanation ${index + 1}`,
    recommended: index === 0,
  }));
  const instance = render(h(PromptInput, {
    onSubmit() {},
    onCommand() {},
    commands: [],
    inputActive: true,
    question: "Choose an implementation",
    questionContext: "This changes compatibility.",
    questionKind: "plan",
    questionOptions: options,
    onSelectOption: option => selected.push(option.id),
  }), { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false });
  await new Promise(resolve => setTimeout(resolve, 30));
  const frame = () => [...stdout.frames].reverse()
    .map(value => stripAnsi(value))
    .find(value => value.trim()) || "";
  let output = frame();
  assert.match(output, /Choice 1 \(Recommended\)/);
  assert.match(output, /Explanation 1/);
  assert.doesNotMatch(output, /Choice 7/);
  for (let index = 0; index < 7; index++) {
    stdin.push("\u001b[B");
    await new Promise(resolve => setTimeout(resolve, 8));
  }
  await new Promise(resolve => setTimeout(resolve, 30));
  output = frame();
  assert.match(output, /Choice 8/);
  assert.doesNotMatch(output, /Choice 1 \(Recommended\)/);
  stdin.push("\r");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(selected, ["option-8"]);
  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});

test("footer reports Plan and approved Build lifecycle modes", async () => {
  const promptProps = { onSubmit() {}, onCommand() {}, commands: [], inputActive: true };
  const planning = await renderComponent(h(SessionFooter, {
    model: "big-cock",
    running: true,
    modeStatus: { mode: "plan", status: "clarifying" },
    promptProps,
  }), 70, 12);
  const building = await renderComponent(h(SessionFooter, {
    model: "big-cock",
    running: true,
    modeStatus: { mode: "build", status: "verifying" },
    promptProps,
  }), 70, 12);
  assert.match(planning, /Plan Mode · Waiting for decision/);
  assert.match(building, /Build Mode · Running verification/);

  assert.ok(planning.indexOf("Plan Mode · Waiting for decision") < planning.indexOf("Ask anything..."),
    "plan mode status should appear above the prompt");
  assert.ok(building.indexOf("Build Mode · Running verification") < building.indexOf("Ask anything..."),
    "build mode status should appear above the prompt");

  assert.equal(planning.match(/big-cock/g)?.length, 1, "model appears exactly once in footer");
  assert.equal(building.match(/big-cock/g)?.length, 1, "model appears exactly once in footer");
});

test("Plan Mode rejects workspace-changing Shell commands without executing them", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-plan-readonly-"));
  const registry = new Registry();
  let executions = 0;
  registry.register({
    name: "bash",
    description: "Run shell",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
    async execute() {
      executions++;
      return "unexpected";
    },
  });
  const agent = new Agent(registry, {
    workspace,
    agent: "plan",
    intentResolver: async () => ({
      intent: "answer",
      category: "ANSWER",
      operation: "answer",
      requiredEvidence: [],
      requiresPlan: false,
    }),
    chat: scripted([
      JSON.stringify({ tool: "bash", args: { command: "touch changed.txt" } }),
      "Implementation Plan\n\nNo files have been modified.",
    ]),
  });
  const events = [];
  for await (const event of agent.loop("Plan a safe change")) events.push(event);
  assert.equal(executions, 0);
  assert.match(events.find(event => event.type === "tool-result")?.result || "", /Plan Mode is read-only/);
  assert.equal(events.find(event => event.type === "tool-result")?.metadata?.planDenied, true);
  assert.equal(events.find(event => event.type === "tool-part" && event.part?.metadata?.planDenied)?.part?.metadata?.hidden, true);
});

test("Plan Mode settles one denied call without retrying the executor", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-plan-denied-once-"));
  const registry = new Registry();
  let executions = 0;
  registry.register({
    name: "bash",
    description: "Run shell",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    async execute() { executions++; return "unexpected"; },
  });
  const denied = JSON.stringify({ tool: "bash", args: { command: "touch changed.txt" } });
  const agent = new Agent(registry, { workspace, agent: "plan", chat: scripted([denied, denied]) });
  const events = [];
  for await (const event of agent.loop("Plan a safe change")) events.push(event);
  assert.equal(executions, 0);
  assert.equal(events.filter(event => event.type === "tool-result").length, 1);
});

test("Plan provider payload contains only read-only native and MCP tools", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-plan-tools-"));
  const registry = new Registry();
  for (const tool of [
    { name: "read" },
    { name: "write" },
    { name: "mcp__docs__search", mcp: { server: "docs", readOnly: true } },
    { name: "mcp__repo__write", mcp: { server: "repo", readOnly: false } },
  ]) registry.register({
    description: tool.name,
    parameters: { type: "object", properties: {} },
    async execute() { return "ok"; },
    ...tool,
  });
  let names = [];
  const agent = new Agent(registry, {
    workspace,
    agent: "plan",
    chat: async (messages, options) => {
      names = options.tools.map(tool => tool.function.name);
      assert.match(messages[0].content, /# Plan mode/);
      assert.doesNotMatch(messages[0].content, /Evidence required|Blocked by Plan mode/);
      return "# Plan\n\n- Goal: inspect safely";
    },
  });
  for await (const _event of agent.loop("Plan the change")) {}
  assert.deepEqual(names.sort(), ["mcp__docs__search", "read"]);
});

test("Plan exploration reuses identical successful reads", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-plan-dedup-"));
  const registry = new Registry();
  let executions = 0;
  registry.register({
    name: "read",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    async execute() { executions++; return "source"; },
  });
  const agent = new Agent(registry, {
    workspace,
    agent: "plan",
    chat: scripted([
      JSON.stringify({ tool: "read", args: { path: "app.js" } }),
      JSON.stringify({ tool: "read", args: { path: "app.js" } }),
      "# Plan\n\n- Goal: update app.js",
    ]),
  });
  for await (const _event of agent.loop("Plan an app.js update")) {}
  assert.equal(executions, 1);
});

test("Plan runs independent read-only exploration with bounded concurrency", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-plan-parallel-"));
  const registry = new Registry();
  const started = [];
  for (const name of ["read", "grep"]) registry.register({
    name,
    description: name,
    parameters: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" } } },
    async execute() {
      started.push(Date.now());
      await new Promise(resolve => setTimeout(resolve, 80));
      return `${name} result`;
    },
  });
  const agent = new Agent(registry, {
    workspace,
    agent: "plan",
    chat: scripted([
      JSON.stringify([
        { tool: "read", args: { path: "app.js" }, id: "read-1" },
        { tool: "grep", args: { pattern: "mode", path: "." }, id: "grep-1" },
      ]),
      "# Plan\n\n- Goal: update mode handling",
    ]),
  });
  for await (const _event of agent.loop("Plan mode handling")) {}
  assert.equal(started.length, 2);
  assert.ok(Math.abs(started[1] - started[0]) < 50, JSON.stringify(started));
});

test("Plan to Build keeps one runtime and uses a hidden synthetic continuation", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-plan-handoff-"));
  let buildMessages = [];
  const agent = new Agent(new Registry(), {
    workspace,
    agent: "plan",
    chat: async messages => {
      if (agent.mode() === "build") buildMessages = messages;
      return agent.mode() === "plan" ? "# Plan\n\n- Goal: update app.js" : "Implemented.";
    },
  });
  for await (const _event of agent.loop("Update app.js", undefined, {
    sessionId: "session-1", runId: "plan-run", turnId: "turn-1", taskEpoch: 1, mode: "plan",
  })) {}
  assert.deepEqual(agent.modeState(), {
    sessionId: agent.modeState().sessionId,
    runId: "plan-run",
    turnId: "turn-1",
    taskEpoch: 1,
    mode: "plan",
  });
  const runtime = agent;
  agent.setMode("build");
  const approvedPlan = { planId: "plan-1", objective: "Update app.js", steps: ["Patch app.js"] };
  for await (const _event of agent.loop(approvedPlanRequest({
    ...approvedPlan,
    decisions: [],
    relevantFiles: ["app.js"],
    summary: "# Plan",
  }), undefined, {
    runId: "build-run",
    turnId: "turn-1",
    taskEpoch: 2,
    mode: "build",
    approvedPlan,
    syntheticContinuation: true,
  })) {}
  assert.equal(agent, runtime);
  assert.equal(agent.modeState().mode, "build");
  assert.equal(agent.modeState().runId, "build-run");
  assert.equal(buildMessages.filter(message => message.role === "user" && message.content === "Update app.js").length, 1);
  assert.ok(buildMessages.some(message => message.role === "system" && /Implement the approved plan/.test(message.content)));
});

test("approved Build runs start once with pending implementation steps", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-approved-build-"));
  const agent = new Agent(new Registry(), {
    workspace,
    agent: "build",
    intentResolver: async () => ({
      intent: "answer",
      category: "ANSWER",
      operation: "answer",
      requiredEvidence: [],
      requiresPlan: false,
    }),
    chat: scripted(["Implementation complete."]),
  });
  const events = [];
  for await (const event of agent.loop("Implement the approved plan", undefined, {
    runId: "build-run",
    turnId: "plan-turn",
    taskEpoch: 4,
    approvedPlan: { planId: "plan-1", steps: ["Patch source", "Run tests"] },
  })) events.push(event);
  const plans = events.filter(event => event.type === "plan");
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].items.map(item => item.status), ["active", "pending"]);
  assert.equal(plans[0].items[0].evidenceIds.length, 0);
  assert.equal(plans[0].planId, "plan-1");
  assert.equal(plans[0].currentStepId, plans[0].items[0].id);
  assert.equal(plans[0].turnId, "plan-turn");
});
