import { resolve } from "node:path";
import { nextId } from "./session-runtime.js";
import {
  analysisActivityMessage, clearAnalysisActivity, pauseAnalysisActivity, startAnalysisActivity,
  updateAnalysisActivity, updatePublicAnalysisActivity,
} from "./analysis-activity.js";

function readFileName(args) {
  const path = String(args?.path || "");
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

export function createSessionActivityController({ analysisScope, analysisRef, activeRef, setActiveMessage, appendArchived, planRef, activeScopeRef, workspacePath, setPlanVisibility, planPanelAfterFinal, thinkActivityFromPlan }) {
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
  analysisRef.current = startAnalysisActivity(
    analysisRef.current,
    analysisScope,
    activity,
  );
  const message = analysisActivityMessage(analysisRef.current);
  if (message) activate(message);
};
const updateAnalysis = activity => {
  analysisRef.current = updateAnalysisActivity(
    analysisRef.current,
    analysisScope,
    activity,
  );
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
  const completedAt = Date.now();
  clearActive();
  const hasFailed = current.failedCount > 0;
  appendArchived({
    ...current,
    done: true,
    failed: hasFailed,
    completedAt,
    duration: completedAt - current.startedAt,
  });
  return true;
};
const recordReadResult = (callId, result, failed = false) => {
  const current = activeRef.current;
  if (
    current?.type !== "read-group"
    || !current.callIds.includes(callId)
    || current.completedCallIds.includes(callId)
  ) return;
  activate({
    ...current,
    completedCallIds: [...current.completedCallIds, callId],
    completedCount: current.completedCount + 1,
    runningCount: Math.max(0, current.runningCount - 1),
    failedCount: current.failedCount + (failed ? 1 : 0),
    failurePreview: failed ? (result || "Error: Read failed") : current.failurePreview,
    currentFile: current.currentFile,
  });
};
const startRead = (callId, args, startedAt = Date.now(), status = "running") => {
  const current = activeRef.current;
  const scope = activeScopeRef.current;
  const filePath = args?.path ? resolve(workspacePath, String(args.path)) : null;
  const currentFile = readFileName(args);
  pauseAnalysis();
  if (current?.type === "read-group") {
    if (current.runId !== scope?.runId || current.turnId !== scope?.turnId) {
      finishReadBatch();
    } else {
      const alreadyCounted = filePath ? current.paths.includes(filePath) : false;
      const next = {
        ...current,
        args,
        currentFile,
        callIds: [...current.callIds, callId],
        paths: alreadyCounted ? current.paths : [...current.paths, filePath],
        count: alreadyCounted ? current.count : current.count + 1,
        runningCount: current.runningCount + 1,
        status,
        startedAt: current.startedAt || startedAt,
      };
      activate(next);
      return;
    }
  }
  activate({
    id: nextId(),
    type: "read-group",
    tool: "read",
    args,
    callIds: [callId],
    completedCallIds: [],
    paths: filePath ? [filePath] : [],
    count: 1,
    currentFile,
    startedAt,
    done: false,
    status,
    runningCount: 1,
    completedCount: 0,
    failedCount: 0,
    failurePreview: "",
    runId: scope?.runId,
    turnId: scope?.turnId,
    taskEpoch: scope?.taskEpoch,
  });
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
