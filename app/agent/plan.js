import { createHash, randomUUID } from "node:crypto";

const INSPECTION_TOOLS = new Set(["read", "glob", "grep", "web", "webfetch", "websearch", "repo"]);
const MUTATION_TOOLS = new Set(["edit", "write", "apply_patch"]);
const VERIFICATION_TOOLS = new Set(["bash"]);
const TERMINAL_FAILURES = /\b(?:timed out|timeout|cancelled|canceled|parser failure|parse error|no tests? (?:found|discovered)|tests? not found|all tests? skipped)\b/i;
const ZERO_TESTS = /(?:\b0\s+passed\s*,?\s*0\s+failed\b|#\s*tests\s+0\b|#\s*pass\s+0\b[\s\S]*#\s*skipped\s+[1-9]\d*)/i;
// Only commands that genuinely run tests, lint, typecheck, or builds may
// produce verification evidence. Inspection and unrelated shell commands
// (`ls`, `grep`, `head`, file inspection, ...) never satisfy verification.
const VERIFICATION_COMMAND = /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|build|typecheck)\b|(?:npx\s+)?(?:eslint|tsc|vitest|jest)\b|pytest\b|python(?:3)?\s+-m\s+(?:pytest|unittest)\b|go\s+test\b|cargo\s+test\b)/i;

export const PLAN_STATUSES = ["pending", "active", "completed", "failed"];

function phaseFor(description) {
  const text = String(description).toLowerCase();
  if (/\b(?:explore|inspect|locate|read|search|investigate|discover|audit|design|architecture)\b/.test(text)) return "exploration";
  if (/\b(?:implement|edit|write|patch|fix|add|create|register|integrate|update|modify|refactor|wire|generate)\b/.test(text)) return "implementation";
  if (/\b(?:tests?|verify|verification|lint|typecheck|type check|build|check)\b/.test(text)) return "verification";
  return "unclassified";
}

function requiredEvidenceFor(phase) {
  if (phase === "exploration") return ["inspection"];
  if (phase === "implementation") return ["mutation"];
  if (phase === "verification") return ["verification"];
  return [];
}

function toolEvidenceType(tool) {
  const name = String(tool?.name || "");
  if (INSPECTION_TOOLS.has(name)) return "inspection";
  if (MUTATION_TOOLS.has(name)) return "mutation";
  if (VERIFICATION_TOOLS.has(name)) return "verification";
  return null;
}

function matchingExisting(existing, description) {
  return existing.find(item => item.description === description);
}

function stepId(planId, description, index, usedIds) {
  const digest = createHash("sha256").update(description).digest("hex").slice(0, 12);
  let id = `${planId}:${digest}`;
  let attempt = 2;
  while (usedIds.has(id)) id = `${planId}:${digest}:${attempt++}`;
  usedIds.add(id);
  return id;
}

function scopeMatches(item, scope) {
  return item.runId === scope?.runId
    && item.turnId === scope?.turnId
    && item.taskEpoch === scope?.taskEpoch;
}

function dependenciesComplete(step, plan) {
  const ids = Array.isArray(step?.dependsOn) ? step.dependsOn : [];
  if (ids.length === 0) return true;
  const byId = new Map((Array.isArray(plan) ? plan : []).map(item => [item.id, item]));
  return ids.every(id => byId.get(id)?.status === "completed");
}

function successfulVerification(tool, result) {
  const output = String(result || "");
  if (String(tool?.name) === "bash") {
    if (!/^Exit:\s*0\b/im.test(output)) return false;
    const command = String(tool?.args?.command || "");
    if (!VERIFICATION_COMMAND.test(command)) return false;
  }
  if (TERMINAL_FAILURES.test(output) || ZERO_TESTS.test(output)) return false;
  return true;
}

/**
 * Separates plan definition from execution state.
 *
 * Step statuses are derived exclusively from execution state (previous
 * evidence-backed statuses). Model-supplied `todo.status` values are never
 * trusted: "completed" flags from the model, step numbers, plan text, or
 * assistant claims cannot mark a step done.
 *
 * Exactly one step may be `active` at a time. When the current step
 * completes, the next eligible pending step becomes active via
 * `selectNextActiveStep`.
 */
export function definePlanItems(todos, currentPlan, scope, planId = randomUUID()) {
  const existing = Array.isArray(currentPlan) ? currentPlan : [];
  const usedIds = new Set();
  const newItems = (Array.isArray(todos) ? todos : []).map((todo, index) => {
    const description = String(todo?.content ?? todo?.description ?? "").trim();
    if (!description) return null;
    const previous = matchingExisting(existing, description);
    const phase = previous?.phase || phaseFor(description);
    const completed = previous?.status === "completed"
      && (previous?.evidenceIds?.length || 0) > 0;
    const failed = previous?.status === "failed";
    const active = previous?.status === "active";
    const id = previous?.id || stepId(planId, description, index, usedIds);
    usedIds.add(id);
    return {
      id,
      planId,
      order: 0,
      title: description,
      description,
      phase,
      status: completed ? "completed" : failed ? "failed" : active ? "active" : "pending",
      dependsOn: [],
      requiredEvidence: previous?.requiredEvidence || requiredEvidenceFor(phase),
      evidenceIds: [...(previous?.evidenceIds || [])],
      startedAt: previous?.startedAt || null,
      completedAt: previous?.completedAt || null,
      runId: scope?.runId,
      turnId: scope?.turnId,
      taskEpoch: scope?.taskEpoch,
      activeToolCallId: active ? previous?.activeToolCallId || null : null,
    };
  }).filter(Boolean);
  const retainedCompleted = existing.filter(previous => (
    previous.status === "completed"
    && !newItems.some(item => item.id === previous.id)
  )).map(item => ({
    ...item,
    runId: scope?.runId,
    turnId: scope?.turnId,
    taskEpoch: scope?.taskEpoch,
  }));
  const items = [...retainedCompleted, ...newItems];
  items.forEach((item, index) => {
    item.order = index + 1;
    item.dependsOn = index === 0 ? [] : [items[index - 1].id];
  });
  // Demote active steps whose dependencies are no longer satisfied.
  for (const item of items) {
    if (item.status === "active" && !dependenciesComplete(item, items)) {
      item.status = "pending";
      item.activeToolCallId = null;
    }
  }
  // Enforce a single active step; any extra active step is demoted.
  let activeSeen = false;
  for (const item of items) {
    if (item.status !== "active") continue;
    if (activeSeen) {
      item.status = "pending";
      item.activeToolCallId = null;
    }
    activeSeen = true;
  }
  // Ensure the current execution step is active when nothing else is.
  if (!activeSeen) {
    const firstEligible = selectNextActiveStep(items);
    if (firstEligible) {
      firstEligible.status = "active";
      firstEligible.startedAt ||= Date.now();
    }
  }
  return items;
}

/**
 * Selects the next eligible pending step: the lowest-ordered pending step
 * whose dependencies are all completed. Returns null when no step is
 * eligible or when a step is already active.
 */
export function selectNextActiveStep(plan) {
  if (!Array.isArray(plan)) return null;
  if (plan.some(item => item.status === "active")) return null;
  const eligible = plan
    .filter(item => item.status === "pending" && dependenciesComplete(item, plan))
    .sort((a, b) => a.order - b.order);
  return eligible[0] || null;
}

/**
 * Allowed transitions:
 *   pending  -> active
 *   active   -> completed (with matching evidence) | failed
 *   failed   -> active
 *
 * `pending -> completed` without matching evidence, `completed -> active`
 * from a stale callback, and any other transition are rejected.
 */
export function canTransition(step, nextStatus, evidence = null) {
  if (!step) return false;
  if (step.status === "pending") return nextStatus === "active";
  if (step.status === "active") {
    if (nextStatus === "failed") return true;
    if (nextStatus === "completed") {
      return Boolean(
        evidence?.valid === true
        && evidence.stepId === step.id
        && evidence.toolCallId === step.activeToolCallId,
      );
    }
    return false;
  }
  if (step.status === "failed") return nextStatus === "active";
  return false;
}

export function associatePlanStep(plan, tool, scope) {
  if (!Array.isArray(plan) || !scopeMatches(plan[0], scope)) return null;
  const evidenceType = toolEvidenceType(tool);
  if (!evidenceType) return null;
  // Only verification commands can be associated with verification steps.
  if (
    evidenceType === "verification"
    && String(tool?.name) === "bash"
    && !VERIFICATION_COMMAND.test(String(tool?.args?.command || ""))
  ) {
    return null;
  }
  const active = plan.find(item => item.status === "active");
  let step;
  if (active) {
    // Normally only one Plan step may be active; its evidence may only come
    // from the tools associated with its required evidence type.
    if (!active.requiredEvidence.includes(evidenceType)) return null;
    step = active;
  } else {
    step = plan.find(item => (
      ["pending", "failed"].includes(item.status)
      && item.requiredEvidence.includes(evidenceType)
      && dependenciesComplete(item, plan)
    ));
  }
  if (!step) return null;
  if (!dependenciesComplete(step, plan)) return null;
  if (step.status !== "active" && !canTransition(step, "active")) return null;
  step.status = "active";
  step.startedAt ||= Date.now();
  step.activeToolCallId = tool.id;
  return {
    plan,
    planId: step.planId,
    stepId: step.id,
    toolCallId: tool.id,
    runId: scope.runId,
    turnId: scope.turnId,
    taskEpoch: scope.taskEpoch,
  };
}

export function settlePlanStep(tracker, tool, result, succeeded, scope) {
  if (!tracker || !scopeMatches(tracker, scope) || tracker.toolCallId !== tool?.id) return null;
  const step = tracker.plan.find(item => item.id === tracker.stepId);
  if (!step || !scopeMatches(step, scope) || step.status !== "active") return null;
  if (!dependenciesComplete(step, tracker.plan)) return null;
  const evidenceType = toolEvidenceType(tool);
  const valid = Boolean(
    succeeded
    && evidenceType
    && step.requiredEvidence.includes(evidenceType)
    && (evidenceType !== "verification" || successfulVerification(tool, result)),
  );
  const evidence = {
    id: `${tracker.toolCallId}:${valid ? "success" : "failure"}`,
    valid,
    stepId: step.id,
    toolCallId: tracker.toolCallId,
    resultStatus: valid ? "completed" : "failed",
  };
  const nextStatus = valid ? "completed" : "failed";
  if (!canTransition(step, nextStatus, evidence)) return null;
  step.status = nextStatus;
  step.activeToolCallId = null;
  if (valid) {
    step.evidenceIds.push(evidence.id);
    step.completedAt = Date.now();
  }
  return { step, evidence };
}

export class PlanMethods {
  _definePlan(todos, scope = this._activeRun, planId = this._planId || randomUUID()) {
    if (!this._isActiveRun(scope)) return null;
    this._planId = planId;
    this._plan = definePlanItems(todos, this._plan, scope, planId);
    this._currentStepId = this._plan.find(item => item.status === "active")?.id || null;
    this._planIndex = this._plan.findIndex(item => item.status !== "completed");
    if (this._planIndex < 0) this._planIndex = this._plan.length;
    if (this._activeScope?.taskEpoch === scope.taskEpoch) {
      this._activeScope.currentPlan = this._plan.map(item => ({ ...item }));
    }
    return this._plan;
  }

  *_startPlanItem(tool, scope = this._activeRun) {
    if (!this._isActiveRun(scope)) return null;
    const tracker = associatePlanStep(this._plan, tool, scope);
    if (!tracker) return null;
    const step = this._plan.find(item => item.id === tracker.stepId);
    if (!step) return null;
    this._currentStepId = step.id;
    this._planIndex = this._plan.indexOf(step);
    if (this._activeScope?.taskEpoch === scope.taskEpoch) {
      this._activeScope.currentPlan = this._plan.map(item => ({ ...item }));
    }
    yield this._scopedToolEvent({
      type: "plan-update",
      planId: tracker.planId,
      stepId: tracker.stepId,
      index: this._plan.indexOf(step),
      status: "active",
      currentStepId: step.id,
      toolCallId: tracker.toolCallId,
    }, scope);
    return tracker;
  }

  *_finishPlanItem(tracker, tool, result, succeeded, scope = this._activeRun) {
    if (!this._isActiveRun(scope) || this._plan !== tracker?.plan) return;
    const settled = settlePlanStep(tracker, tool, result, succeeded, scope);
    if (!settled) return;
    const step = settled.step;
    const index = this._plan.indexOf(step);
    let nextActive = null;
    if (step.status === "completed") {
      nextActive = selectNextActiveStep(this._plan);
      if (nextActive) {
        nextActive.status = "active";
        nextActive.startedAt ||= Date.now();
      }
      this._currentStepId = nextActive?.id || step.id;
      this._planIndex = this._plan.findIndex(item => item.status !== "completed");
      if (this._planIndex < 0) this._planIndex = this._plan.length;
    } else {
      // Failed: keep the step as the current step so a matching retry can
      // reactivate it (failed -> active).
      this._currentStepId = step.id;
      this._planIndex = index;
    }
    if (this._activeScope?.taskEpoch === scope.taskEpoch) {
      this._activeScope.currentPlan = this._plan.map(item => ({ ...item }));
    }
    yield this._scopedToolEvent({
      type: "plan-update",
      planId: tracker.planId,
      stepId: step.id,
      index,
      status: step.status,
      currentStepId: this._currentStepId,
      toolCallId: tracker.toolCallId,
      evidence: settled.evidence,
    }, scope);
    if (nextActive) {
      yield this._scopedToolEvent({
        type: "plan-update",
        planId: tracker.planId,
        stepId: nextActive.id,
        index: this._plan.indexOf(nextActive),
        status: "active",
        currentStepId: nextActive.id,
        toolCallId: tracker.toolCallId,
      }, scope);
    }
  }
}
