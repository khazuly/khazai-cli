const DEFAULT_TEXT = "Analyzing the execution context";

function publicField(value, maximum) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function matchesScope(state, scope) {
  return Boolean(
    state
    && scope
    && state.runId === scope.runId
    && state.turnId === scope.turnId
    && state.taskEpoch === scope.taskEpoch
  );
}

function accumulate(state, now) {
  if (state.status !== "active" || state.activeStartedAt === null) return state;
  return {
    ...state,
    accumulatedDurationMs: state.accumulatedDurationMs + Math.max(0, now - state.activeStartedAt),
    activeStartedAt: null,
  };
}

export function createAnalysisActivity({ runId, turnId, taskEpoch, analysisId }) {
  return {
    runId,
    turnId,
    taskEpoch,
    analysisId,
    status: "idle",
    accumulatedDurationMs: 0,
    activeStartedAt: null,
    phase: 0,
    text: DEFAULT_TEXT,
    step: null,
    publicActivity: null,
    toolCallId: null,
  };
}

export function startAnalysisActivity(state, scope, activity = {}, now = Date.now()) {
  if (!matchesScope(state, scope)) return state;
  const wasActive = state.status === "active";
  return {
    ...state,
    status: "active",
    activeStartedAt: wasActive ? state.activeStartedAt : now,
    phase: wasActive ? state.phase : state.phase + 1,
    text: activity.text || state.text || DEFAULT_TEXT,
    step: activity.step ?? null,
  };
}

export function updateAnalysisActivity(state, scope, activity = {}) {
  if (!matchesScope(state, scope)) return state;
  return {
    ...state,
    text: activity.text || state.text || DEFAULT_TEXT,
    step: activity.step ?? null,
  };
}

export function updatePublicAnalysisActivity(state, scope, toolCallId, publicActivity = {}) {
  const activity = publicField(publicActivity.activity, 120);
  if (!matchesScope(state, scope) || !toolCallId || !activity) return state;
  return {
    ...state,
    toolCallId,
    publicActivity: {
      activity,
      target: publicField(publicActivity.target, 160),
      nextAction: publicField(publicActivity.nextAction, 160),
      progress: /^\d+\s*\/\s*\d+$/.test(String(publicActivity.progress || ""))
        ? String(publicActivity.progress).replace(/\s+/g, "")
        : "",
    },
  };
}

export function clearPublicAnalysisActivity(state, scope, toolCallId = null) {
  if (!matchesScope(state, scope) || toolCallId && state.toolCallId !== toolCallId) return state;
  return { ...state, publicActivity: null, toolCallId: null };
}

export function pauseAnalysisActivity(state, scope, now = Date.now()) {
  if (!matchesScope(state, scope)) return state;
  return { ...accumulate(state, now), status: "paused" };
}

export function completeAnalysisActivity(state, scope, now = Date.now()) {
  if (!matchesScope(state, scope) || ["completed", "failed"].includes(state.status)) return state;
  return { ...accumulate(state, now), status: "completed" };
}

export function failAnalysisActivity(state, scope, now = Date.now()) {
  if (!matchesScope(state, scope) || ["completed", "failed"].includes(state.status)) return state;
  return { ...accumulate(state, now), status: "failed" };
}

export function clearAnalysisActivity(state, scope) {
  return matchesScope(state, scope) ? null : state;
}

export function analysisActivityMessage(state) {
  if (!state || !["active", "completed", "failed"].includes(state.status)) return null;
  const failed = state.status === "failed";
  const publicActivity = state.status === "active" ? state.publicActivity : null;
  return {
    id: state.analysisId,
    type: "think",
    text: failed ? "Analysis timed out" : state.status === "completed"
      ? "Analysis completed"
      : publicActivity?.activity || state.text,
    step: state.status === "active" && !publicActivity ? state.step : null,
    target: publicActivity?.target || "",
    nextAction: publicActivity?.nextAction || "",
    progress: publicActivity?.progress || "",
    toolCallId: state.toolCallId,
    done: ["completed", "failed"].includes(state.status),
    failed,
    accumulatedDurationMs: state.accumulatedDurationMs,
    activeStartedAt: state.activeStartedAt,
    phase: state.phase,
    runId: state.runId,
    turnId: state.turnId,
    taskEpoch: state.taskEpoch,
  };
}

export function analysisEventIsCurrent(event, scope) {
  return (!event.runId || event.runId === scope.runId)
    && (!event.turnId || event.turnId === scope.turnId)
    && (!event.taskEpoch || event.taskEpoch === scope.taskEpoch);
}
