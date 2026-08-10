import {
  analysisActivityMessage, clearAnalysisActivity, pauseAnalysisActivity, startAnalysisActivity,
  updateAnalysisActivity, updatePublicAnalysisActivity,
} from "./analysis-activity.js";
import {
  addReadToBatch, completeReadInBatch, createReadBatch, finishReadBatch as finalizeReadBatch,
  readBatchMatchesScope,
} from "./read-batch.js";

export function createSessionActivityController({ analysisScope, analysisRef, activeRef, setActiveMessage, appendArchived, planRef, activeScopeRef, workspacePath, setPlanVisibility, planPanelAfterFinal, thinkActivityFromPlan }) {
  let readBatchSequence = 0;
  const activate = message => {
    activeRef.current = message;
    setActiveMessage(message);
  };
  const clearActive = () => {
    activeRef.current = null;
    setActiveMessage(null);
  };
  const pauseAnalysis = (now = Date.now()) => {
    analysisRef.current = pauseAnalysisActivity(analysisRef.current, analysisScope, now);
    if (activeRef.current?.id === analysisRef.current?.analysisId) clearActive();
  };
  const resumeAnalysis = (now = Date.now()) => {
    analysisRef.current = startAnalysisActivity(analysisRef.current, analysisScope, {}, now);
  };
  const showAnalysis = activity => {
    analysisRef.current = startAnalysisActivity(analysisRef.current, analysisScope, activity);
    const message = analysisActivityMessage(analysisRef.current);
    if (message) activate(message);
  };
  const updateAnalysis = activity => {
    analysisRef.current = updateAnalysisActivity(analysisRef.current, analysisScope, activity);
    if (activeRef.current?.id === analysisRef.current?.analysisId) {
      activate(analysisActivityMessage(analysisRef.current));
    }
  };
  const showPublicAnalysis = (toolCallId, publicActivity) => {
    analysisRef.current = startAnalysisActivity(
      analysisRef.current,
      analysisScope,
      thinkActivityFromPlan(planRef.current.steps, undefined, planRef.current.currentStepId),
    );
    analysisRef.current = updatePublicAnalysisActivity(
      analysisRef.current,
      analysisScope,
      toolCallId,
      publicActivity,
    );
    const message = analysisActivityMessage(analysisRef.current);
    if (message) activate(message);
  };
  const finishReadBatch = () => {
    const current = activeRef.current;
    if (current?.type !== "read-group") return false;
    const batch = finalizeReadBatch(current, Date.now());
    clearActive();
    appendArchived({ ...batch, expanded: false });
    return true;
  };
  const recordReadResult = (callId, _result, failed = false, finishedAt = Date.now()) => {
    const current = activeRef.current;
    if (current?.type !== "read-group" || !current.callIds.includes(callId)) return;
    const next = completeReadInBatch(current, callId, failed, finishedAt);
    if (next !== current) activate(next);
  };
  const startRead = (callId, args, startedAt = Date.now(), status = "running") => {
    const current = activeRef.current;
    const scope = { ...activeScopeRef.current, workspacePath };
    pauseAnalysis();
    if (current?.type === "read-group") {
      if (!readBatchMatchesScope(current, scope) || current.done) {
        finishReadBatch();
      } else {
        const next = addReadToBatch(current, callId, args, startedAt);
        if (next !== current) activate({ ...next, status });
        return;
      }
    }
    readBatchSequence++;
    activate({ ...createReadBatch(scope, readBatchSequence, callId, args, startedAt), status });
  };
  const planMatchesRun = state => state.runId === analysisScope.runId
    && state.turnId === analysisScope.turnId
    && state.taskEpoch === analysisScope.taskEpoch;
  const clearPlanActivity = () => {
    analysisRef.current = clearAnalysisActivity(analysisRef.current, analysisScope);
    if (activeRef.current?.type === "think") clearActive();
  };
  const cleanupCompletedPlan = () => {
    const current = planRef.current;
    if (planPanelAfterFinal(current, analysisScope, true) !== null) return;
    clearPlanActivity();
    setPlanVisibility(null);
  };
  return { activate, clearActive, pauseAnalysis, resumeAnalysis, showAnalysis, updateAnalysis, showPublicAnalysis, finishReadBatch, recordReadResult, startRead, planMatchesRun, clearPlanActivity, cleanupCompletedPlan };
}
