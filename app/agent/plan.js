import { createHash, randomUUID } from "node:crypto";

const INSPECTION_TOOLS = new Set(["read", "glob", "grep", "web", "webfetch", "websearch", "repo"]);
const MUTATION_TOOLS = new Set(["edit", "write", "apply_patch"]);
const VERIFICATION_TOOLS = new Set(["bash", "analyze"]);
const TERMINAL_FAILURES = /\b(?:timed out|timeout|cancelled|canceled|parser failure|parse error|no tests? (?:found|discovered)|tests? not found|all tests? skipped)\b/i;
const ZERO_TESTS = /(?:\b0\s+passed\s*,?\s*0\s+failed\b|#\s*tests\s+0\b|#\s*pass\s+0\b[\s\S]*#\s*skipped\s+[1-9]\d*)/i;

function phaseFor(description) {
  const text = String(description).toLowerCase();
  if (/\b(?:explore|inspect|locate|read|search|investigate|discover|audit)\b/.test(text)) return "exploration";
  if (/\b(?:implement|edit|write|patch|fix|add|create|register|integrate|update|modify)\b/.test(text)) return "implementation";
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

function stepId(planId, description, index) {
  const digest = createHash("sha256").update(description).digest("hex").slice(0, 12);
  return `${planId}:${digest}:${index + 1}`;
}

function scopeMatches(item, scope) {
  return item.runId === scope?.runId
    && item.turnId === scope?.turnId
    && item.taskEpoch === scope?.taskEpoch;
}

function successfulVerification(tool, result) {
  const output = String(result || "");
  if (String(tool?.name) === "bash" && !/^Exit:\s*0\b/im.test(output)) return false;
  if (TERMINAL_FAILURES.test(output) || ZERO_TESTS.test(output)) return false;
  return true;
}

export function definePlanItems(todos, currentPlan, scope, planId = randomUUID()) {
  const existing = Array.isArray(currentPlan) ? currentPlan : [];
  let activeAssigned = false;
  let precedingStepsCompleted = true;
  const items = (Array.isArray(todos) ? todos : []).map((todo, index) => {
    const description = String(todo?.content ?? todo?.description ?? "").trim();
    const previous = matchingExisting(existing, description);
    const phase = previous?.phase || phaseFor(description);
    const completed = previous?.status === "done";
    const failed = previous?.status === "failed";
    const modelSelected = todo?.status === "in_progress"
      && !activeAssigned
      && !completed
      && precedingStepsCompleted;
    const retainedActive = previous?.status === "running" && !activeAssigned && precedingStepsCompleted;
    const status = completed ? "done" : failed ? "failed" : modelSelected || retainedActive ? "running" : "pending";
    if (status === "running") activeAssigned = true;
    precedingStepsCompleted &&= completed;
    return {
      id: previous?.id || stepId(planId, description, index),
      description,
      phase,
      status,
      requiredEvidence: previous?.requiredEvidence || requiredEvidenceFor(phase),
      evidenceIds: [...(previous?.evidenceIds || [])],
      startedAt: previous?.startedAt || null,
      completedAt: previous?.completedAt || null,
      runId: scope?.runId,
      turnId: scope?.turnId,
      taskEpoch: scope?.taskEpoch,
      activeToolCallId: status === "running" ? previous?.activeToolCallId || null : null,
    };
  });
  const retainedCompleted = existing.filter(previous => (
    previous.status === "done"
    && !items.some(item => item.id === previous.id)
  ));
  return [...retainedCompleted, ...items];
}

export function canTransition(step, nextStatus, evidence = null) {
  if (!step) return false;
  if (step.status === "pending") return nextStatus === "running" || nextStatus === "cancelled";
  if (step.status === "running") {
    if (nextStatus === "failed" || nextStatus === "cancelled") return true;
    return nextStatus === "done"
      && evidence?.valid === true
      && evidence.stepId === step.id
      && evidence.toolCallId === step.activeToolCallId;
  }
  return step.status === "failed" && nextStatus === "running";
}

export function associatePlanStep(plan, tool, scope) {
  if (!Array.isArray(plan) || !scopeMatches(plan[0], scope)) return null;
  const evidenceType = toolEvidenceType(tool);
  const active = plan.find(item => item.status === "running");
  const step = active || plan.find(item => (
    ["pending", "failed"].includes(item.status)
    && item.requiredEvidence.includes(evidenceType)
  ));
  if (!step) return null;
  if (!step.requiredEvidence.includes(evidenceType)) return null;
  if (step.status === "pending" && !canTransition(step, "running")) return null;
  if (step.status === "failed" && !canTransition(step, "running")) return null;
  step.status = "running";
  step.startedAt ||= Date.now();
  step.activeToolCallId = tool.id;
  return {
    plan,
    planId: String(step.id).split(":")[0],
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
  if (!step || !scopeMatches(step, scope) || step.status !== "running") return null;
  const evidenceType = toolEvidenceType(tool);
  const valid = Boolean(
    succeeded
    && step.requiredEvidence.includes(evidenceType)
    && (evidenceType !== "verification" || successfulVerification(tool, result))
  );
  const evidence = {
    id: `${tracker.toolCallId}:${valid ? "success" : "failure"}`,
    valid,
    stepId: step.id,
    toolCallId: tracker.toolCallId,
    resultStatus: valid ? "completed" : "failed",
  };
  const nextStatus = valid ? "done" : "failed";
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
    this._planIndex = this._plan.findIndex(item => item.status !== "done");
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
    const index = this._plan.findIndex(item => item.id === tracker.stepId);
    this._activeScope.currentPlan = this._plan.map(item => ({ ...item }));
    yield this._scopedToolEvent({ type: "plan-update", index, status: "running" }, scope);
    return tracker;
  }

  *_finishPlanItem(tracker, tool, result, succeeded, scope = this._activeRun) {
    if (!this._isActiveRun(scope) || this._plan !== tracker?.plan) return;
    const settled = settlePlanStep(tracker, tool, result, succeeded, scope);
    if (!settled) return;
    const index = this._plan.findIndex(item => item.id === settled.step.id);
    this._planIndex = settled.step.status === "done"
      ? this._plan.findIndex(item => item.status !== "done")
      : index;
    if (this._planIndex < 0) this._planIndex = this._plan.length;
    this._activeScope.currentPlan = this._plan.map(item => ({ ...item }));
    yield this._scopedToolEvent({
      type: "plan-update",
      index,
      status: settled.step.status,
      evidence: settled.evidence,
    }, scope);
  }
}
