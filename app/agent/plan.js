import { createHash, randomUUID } from "node:crypto";

export const PLAN_STATUSES = ["pending", "in_progress", "completed", "cancelled"];

export const EMPTY_PLAN_STATE = Object.freeze({
  planId: null,
  revision: 0,
  runId: null,
  turnId: null,
  taskEpoch: null,
  status: "active",
  currentStepId: null,
  steps: [],
});

function normalizedStatus(status) {
  const value = String(status || "").trim().toLowerCase();
  if (["done", "complete", "completed"].includes(value)) return "completed";
  if (["active", "running", "in-progress", "in_progress", "in progress"].includes(value)) return "in_progress";
  if (["cancelled", "canceled", "failed", "blocked", "error"].includes(value)) return "cancelled";
  return "pending";
}

function itemText(item) {
  return String(item?.description || item?.text || item?.content || item?.title || "").trim();
}

function itemId(planId, text, occurrence) {
  const digest = createHash("sha256").update(text).digest("hex").slice(0, 12);
  return `${planId || "plan"}:${digest}:${occurrence}`;
}

function normalizeItems(items, planId, scope = {}) {
  const occurrences = new Map();
  return (Array.isArray(items) ? items : []).map((item, index) => {
    const description = itemText(item);
    if (!description) return null;
    const occurrence = (occurrences.get(description) || 0) + 1;
    occurrences.set(description, occurrence);
    const id = String(item?.id || item?.stepId || itemId(planId, description, occurrence));
    return {
      id,
      stepId: id,
      planId,
      order: index + 1,
      title: description,
      description,
      status: normalizedStatus(item?.status),
      runId: scope.runId ?? item?.runId ?? null,
      turnId: scope.turnId ?? item?.turnId ?? null,
      taskEpoch: scope.taskEpoch ?? item?.taskEpoch ?? null,
    };
  }).filter(Boolean);
}

export function normalizePlanState(snapshot = {}) {
  const planId = snapshot.planId || null;
  const steps = normalizeItems(snapshot.steps || snapshot.items, planId, snapshot);
  const completed = steps.length > 0 && steps.every(step => step.status === "completed");
  return {
    planId,
    revision: Number.isInteger(snapshot.revision) ? snapshot.revision : 0,
    runId: snapshot.runId || null,
    turnId: snapshot.turnId || null,
    taskEpoch: snapshot.taskEpoch ?? null,
    status: snapshot.status === "cancelled" ? "cancelled" : completed ? "completed" : "active",
    currentStepId: null,
    steps,
  };
}

export function applyPlanSnapshot(current = EMPTY_PLAN_STATE, snapshot = {}, allowNewPlan = false) {
  const incomingPlanId = snapshot.planId || current.planId;
  const samePlan = Boolean(current.planId && incomingPlanId === current.planId);
  if (current.planId && !samePlan && !allowNewPlan) return current;
  if (samePlan && Number.isInteger(snapshot.revision) && snapshot.revision <= current.revision) return current;
  return normalizePlanState({ ...snapshot, planId: incomingPlanId });
}

export function planCounts(items) {
  const counts = { completed: 0, in_progress: 0, pending: 0, cancelled: 0, total: 0 };
  for (const item of Array.isArray(items) ? items : []) {
    counts.total++;
    counts[normalizedStatus(item?.status)]++;
  }
  return counts;
}

export function validatePlanState(state = {}) {
  const steps = Array.isArray(state.steps) ? state.steps : [];
  const ids = steps.map(step => step.id);
  const violations = ids.length === new Set(ids).size ? [] : ["duplicate todo id"];
  return { ok: violations.length === 0, violations, counts: planCounts(steps) };
}

export function definePlanItems(todos, _currentPlan, scope, planId = randomUUID()) {
  return normalizeItems(todos, planId, scope);
}

export class PlanMethods {
  _definePlan(todos, scope = this._activeRun, planId = this._planId || randomUUID()) {
    if (!this._isActiveRun(scope)) return null;
    this._planId = planId;
    this._plan = definePlanItems(todos, null, scope, planId);
    this._currentStepId = null;
    this._planIndex = 0;
    this._planStatus = this._plan.length > 0 && this._plan.every(item => item.status === "completed")
      ? "completed"
      : "active";
    this._planRevision += 1;
    if (this._activeScope?.taskEpoch === scope.taskEpoch) {
      this._activeScope.currentPlan = this._plan.map(item => ({ ...item }));
    }
    return this._plan;
  }

  _planSnapshot(planId) {
    return {
      planId,
      revision: this._planRevision,
      status: this._planStatus,
      currentStepId: null,
      counts: planCounts(this._plan),
      items: this._plan.map(item => ({ ...item })),
    };
  }

  *_startPlanItem() {}

  *_finishPlanItem() {}
}
