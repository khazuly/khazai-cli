import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement as h } from "react";
import { render } from "ink";
import { Agent } from "../app/agent.js";
import {
  approvePlanMode,
  approvedPlanRequest,
  changedPlanFiles,
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
  const scope = { runId: "run-1", turnId: "turn-1", taskEpoch: 3 };
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
  assert.equal(approved.decisions[0].optionId, "provider-fallback");
  assert.equal(approved.relevantFiles[0], "app.js");
  assert.equal(approvePlanMode(approved), null);
  assert.match(approvedPlanRequest(approved), /Provider metadata with tokenizer fallback/);
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
    modeStatus: { mode: "plan", status: "questioning" },
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
  assert.deepEqual(plans[0].items.map(item => item.status), ["pending", "pending"]);
  assert.equal(plans[0].turnId, "plan-turn");
});
