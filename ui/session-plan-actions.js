import { useCallback } from "react";

export function usePlanSessionActions(context) {
  const { PLAN_ACTIONS, REVALIDATION_ACTIONS, abortRef, activeRef, activeScopeRef, agentRef, analysisRef, appendArchived, approvePlanMode, approvedPlanRequest, buildStartedPlanIdRef, cancelledRunIdRef, changedPlanFiles, currentSessionRef, messageQueueRef, normalizePlanState, openPlanApprovalRef, pendingPermissionCallIdRef, pendingQuestion, planActionRef, planRef, planWorkflowRef, planningQuestionRef, prepareRunInterruption, questionResolverRef, recordPlanDecision, refreshPlanSnapshots, responseBufferRef, sessionStoreRef, setActiveMessage, setModeStatus, setPendingQuestion, setPlan, setPlanVisibility, submitRef, submittingRef, workspace, taskEpochRef, setRunning, clearPublicAnalysisActivity, clearAnalysisActivity, nextId } = context;
const replaceAgentProfile = useCallback(name => {
  agentRef.current?.setMode(name);
  currentSessionRef.current.agent = name;
  currentSessionRef.current.agentState = agentRef.current.exportSessionState();
  currentSessionRef.current = sessionStoreRef.current.save(currentSessionRef.current);
}, []);

const launchApprovedPlan = useCallback(plan => {
  if (
    !plan
    || plan.status !== "approved"
    || buildStartedPlanIdRef.current === plan.planId
    || messageQueueRef.current.exiting
  ) return;
  buildStartedPlanIdRef.current = plan.planId;
  planWorkflowRef.current = plan;
  replaceAgentProfile("build");
  setPendingQuestion(null);
  setModeStatus({ mode: "build", status: "preparing" });
  setPlan(normalizePlanState({
    planId: plan.planId,
    revision: 0,
    status: "active",
    steps: plan.steps.map(description => ({ description, status: "pending" })),
  }));
  setPlanVisibility(plan.planId);
  queueMicrotask(() => submitRef.current?.(approvedPlanRequest(plan), {
    approvedPlan: plan,
    internalInput: true,
    turnId: plan.turnId,
  }));
}, [replaceAgentProfile, setPlan]);

const openPlanSelection = useCallback((kind, question, context, options, plan) => {
  if (planWorkflowRef.current?.planId !== plan.planId) return;
  questionResolverRef.current = {
    kind,
    archive: false,
    scope: null,
    resolve: answer => planActionRef.current?.(kind, answer, {
      planId: plan.planId,
      sessionId: plan.sessionId,
      runId: plan.runId,
      turnId: plan.turnId,
      taskEpoch: plan.taskEpoch,
      planRevision: plan.planRevision,
    }),
  };
  setPendingQuestion({ kind: "plan", question, context, options });
}, []);

openPlanApprovalRef.current = plan => {
  const awaiting = { ...plan, status: "awaiting" };
  planWorkflowRef.current = awaiting;
  setModeStatus({ mode: "plan", status: "awaiting" });
  openPlanSelection(
    "plan-approval",
    "Plan ready",
    "Choose whether to build the plan now.",
    PLAN_ACTIONS,
    awaiting,
  );
};

planActionRef.current = (kind, answer, expected) => {
  const plan = planWorkflowRef.current;
  const action = typeof answer === "string" ? answer : answer?.id || answer?.label;
  if (
    !plan
    || plan.planId !== expected?.planId
    || plan.sessionId !== expected?.sessionId
    || plan.runId !== expected?.runId
    || plan.turnId !== expected?.turnId
    || plan.taskEpoch !== expected?.taskEpoch
    || plan.planRevision !== expected?.planRevision
  ) return;
  if (kind === "plan-revalidation") {
    if (action === "revalidate") {
      const refreshed = refreshPlanSnapshots(plan, workspace.path);
      planWorkflowRef.current = refreshed;
      launchApprovedPlan(refreshed);
    } else if (action === "plan") {
      buildStartedPlanIdRef.current = null;
      planWorkflowRef.current = { ...plan, mode: "plan", status: "ready", approvedAt: null };
      replaceAgentProfile("plan");
      setModeStatus({ mode: "plan", status: "ready" });
    } else {
      planWorkflowRef.current = null;
      buildStartedPlanIdRef.current = null;
      replaceAgentProfile("build");
      setPlan([]);
      setModeStatus(null);
    }
    return;
  }
  if (plan.status !== "awaiting") return;
  if (action === "build") {
    const approved = approvePlanMode(plan);
    if (!approved) return;
    planWorkflowRef.current = approved;
    const changed = changedPlanFiles(approved, workspace.path);
    if (changed.length) {
      openPlanSelection(
        "plan-revalidation",
        "The codebase changed after this plan was created.",
        `Changed: ${changed.join(", ")}`,
        REVALIDATION_ACTIONS,
        approved,
      );
    } else {
      launchApprovedPlan(approved);
    }
    return;
  }
  if (action === "continue") {
    planWorkflowRef.current = { ...plan, status: "exploring" };
    setModeStatus({ mode: "plan", status: "exploring" });
    return;
  }
  planWorkflowRef.current = null;
  buildStartedPlanIdRef.current = null;
  replaceAgentProfile("build");
  setPlan([]);
  setModeStatus(null);
};

const answerQuestion = useCallback(answer => {
  const pending = questionResolverRef.current;
  const selected = typeof answer === "object" && answer
    ? answer
    : {
        id: "",
        label: String(answer || "").trim(),
        custom: ["plan-custom", "question-custom"].includes(pendingQuestion?.kind),
      };
  const value = String(selected.label || "").trim();
  if (!pending || !value) return;
  const current = activeScopeRef.current;
  if (
    pending.scope
    && (!current
      || current.runId !== pending.scope.runId
      || current.turnId !== pending.scope.turnId
      || current.taskEpoch !== pending.scope.taskEpoch)
  ) {
    questionResolverRef.current = null;
    pending.resolve("");
    if (pending.kind === "permission") pendingPermissionCallIdRef.current = null;
    return;
  }
  if (pending.kind === "permission" && pending.callId !== pendingPermissionCallIdRef.current) {
    questionResolverRef.current = null;
    setPendingQuestion(null);
    pendingPermissionCallIdRef.current = null;
    pending.resolve("reject");
    return;
  }
  if (selected.custom && ["plan-decision", "question"].includes(pending.kind)) {
    setPendingQuestion(current => ({
      ...current,
      options: [],
      kind: pending.kind === "plan-decision" ? "plan-custom" : "question-custom",
      context: "Enter a custom answer below.",
    }));
    return;
  }
  const secret = Boolean(pendingQuestion?.secret);
  questionResolverRef.current = null;
  setPendingQuestion(null);
  if (pending.kind === "permission") pendingPermissionCallIdRef.current = null;
  if (pending.kind === "plan-decision") {
    const currentPlan = planWorkflowRef.current;
    if (currentPlan && planningQuestionRef.current) {
      planWorkflowRef.current = recordPlanDecision(
        currentPlan,
        planningQuestionRef.current,
        selected,
      );
    }
    planningQuestionRef.current = null;
    setModeStatus({ mode: "plan", status: "exploring" });
  }
  if (pending.kind !== "permission" && pending.archive !== false) {
    appendArchived({ id: nextId(), type: "user", content: secret ? "[credential provided]" : value });
  }
  pending.resolve(selected.id ? selected : value);
}, [appendArchived, pendingQuestion]);

const cancelQuestion = useCallback(() => {
  const pending = questionResolverRef.current;
  if (!pending) return;
  questionResolverRef.current = null;
  setPendingQuestion(null);
  if (pending.kind === "permission") pendingPermissionCallIdRef.current = null;
  if (pending.kind === "plan-approval" || pending.kind === "plan-revalidation") {
    const plan = planWorkflowRef.current;
    planActionRef.current?.(pending.kind, { id: "cancel", label: "Cancel" }, plan && {
      planId: plan.planId,
      sessionId: plan.sessionId,
      runId: plan.runId,
      turnId: plan.turnId,
      taskEpoch: plan.taskEpoch,
      planRevision: plan.planRevision,
    });
    return;
  }
  if (pending.kind === "plan-decision") {
    planningQuestionRef.current = null;
    setModeStatus({ mode: "plan", status: "exploring" });
  }
  pending.resolve("");
}, []);

const handleAbort = useCallback(() => {
  const interruption = prepareRunInterruption({
    submitting: submittingRef.current,
    scope: activeScopeRef.current,
    cancelledRunId: cancelledRunIdRef.current,
    responseBuffer: responseBufferRef.current,
  });
  if (!interruption.accepted) return;
  activeRef.current = null;
  setActiveMessage(null);
  cancelledRunIdRef.current = interruption.runId;
  activeScopeRef.current = null;
  const pending = questionResolverRef.current;
  questionResolverRef.current = null;
  pending?.resolve("");
  if (pending?.kind === "permission") pendingPermissionCallIdRef.current = null;
  responseBufferRef.current = interruption.responseBuffer;
  analysisRef.current = null;
  setPendingQuestion(null);
  const currentPlan = planRef.current;
  if (currentPlan.steps.length > 0) {
    setPlan(normalizePlanState({
      ...currentPlan,
      revision: currentPlan.revision + 1,
      status: "cancelled",
      currentStepId: null,
      steps: currentPlan.steps.map(step => step.status === "active" ? { ...step, status: "failed" } : step),
    }));
  }
  agentRef.current?.abort();
  if (planWorkflowRef.current?.mode === "plan") {
    planWorkflowRef.current = null;
    planningQuestionRef.current = null;
    replaceAgentProfile("build");
    setModeStatus(null);
  }
  appendArchived({ id: nextId(), type: "answer", content: "Interrupted by user." });
}, [appendArchived, replaceAgentProfile, setPlan]);
abortRef.current = handleAbort;

  return { replaceAgentProfile, launchApprovedPlan, openPlanSelection, answerQuestion, cancelQuestion, handleAbort };
}
