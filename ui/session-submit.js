export function createSessionSubmit(context) {
  const { EMPTY_PLAN_STATE, activeRef, activeScopeRef, agentRef, agentSessionRef, analysisActivityMessage, analysisEventIsCurrent, analysisRef, appendArchived, appendResponseDelta, applyPlanEventState, applyPlanUpdateState, buildStartedPlanIdRef, cancelledRunIdRef, classifyToolState, cleanPlanOutput, clearAnalysisActivity, clearPublicAnalysisActivity, commitResponseBuffer, completeAnalysisActivity, completedRef, consumeSessionEvents, contextUsageRef, createAnalysisActivity, createPlanModeState, createResponseBuffer, createSessionActivityController, currentSessionRef, discardResponseBuffer, failAnalysisActivity, finalizePlanMode, initRunRef, listWorkspaceFiles, messageQueueRef, normalizePlanState, openPlanApprovalRef, pendingPermissionCallIdRef, planRef, planWorkflowRef, planningQuestionRef, questionResolverRef, redactSecrets, removeAssistantProtocolText, removeEmoji, resetResponseBuffer, resolve, responseBufferRef, sessionStoreRef, setActiveMessage, setContextUsage, setExpandedTool, setModeStatus, setPendingQuestion, setPlan, setPlanVisibility, setQueuedCount, setRunning, setWorkspaceFiles, structuredCallsRef, submitRef, submittingRef, taskEpochRef, terminalRunResult, verifyInitTarget, workspace, nextId, planPanelAfterFinal, normalizeStreamText, toolResultFailed, isInternalAgentFailure, isCompletionClaim, readFileName, thinkActivityFromPlan, setSessionKey } = context;
  return async (input, options = {}) => {
const retryProvider = Boolean(options.retryProvider);
const approvedPlan = options.approvedPlan || null;
const internalInput = Boolean(options.internalInput);
const queuedItemId = options.queuedItemId || null;
const initialization = options.initialization || null;
if (!retryProvider && !input.trim()) return;
if (submittingRef.current) {
  if (!retryProvider && !queuedItemId) {
    messageQueueRef.current.enqueue(input, redactSecrets(input));
    setQueuedCount(messageQueueRef.current.pendingCount());
  }
  return;
}
if (queuedItemId && !messageQueueRef.current.markRunning(queuedItemId)) return;
setExpandedTool(null);
structuredCallsRef.current.clear();
submittingRef.current = true;
setRunning(true);
const runState = {
  finishedNormally: false,
  finalCommitted: false,
  fatalError: "",
  recoverableFailure: false,
  queueHandoffPending: false,
  handedOffForQueue: false,
  finalResponse: "",
  latestPlan: [],
  finalizedPlanningState: null,
  planningState: null,
};
const sessionBefore = currentSessionRef.current;
const runId = nextId();
const turnId = options.turnId || `${sessionBefore?.id || "session"}-${runId}`;
if (!retryProvider) taskEpochRef.current++;
const planningRun = currentSessionRef.current.agent === "plan" && !approvedPlan;
const analysisScope = {
  sessionId: sessionBefore?.id,
  runId,
  turnId,
  taskEpoch: taskEpochRef.current,
  mode: planningRun ? "plan" : "build",
  ...(approvedPlan?.planId ? { planId: approvedPlan.planId } : {}),
};
const previousPlan = planWorkflowRef.current;
runState.planningState = planningRun
  ? previousPlan?.mode === "plan" && ["ready", "exploring", "clarifying"].includes(previousPlan.status)
    ? { ...previousPlan, ...analysisScope, status: "exploring" }
    : createPlanModeState({ objective: input, ...analysisScope })
  : null;
if (planningRun) {
  runState.planningState = { ...runState.planningState, status: "exploring" };
  planWorkflowRef.current = runState.planningState;
  setModeStatus({ mode: "plan", status: "exploring" });
} else if (approvedPlan) {
  setModeStatus({ mode: "build", status: "preparing" });
}
activeScopeRef.current = analysisScope;
if (initialization) {
  initRunRef.current = {
    status: "running",
    workspaceRoot: initialization.workspaceRoot,
    targetPath: initialization.targetPath,
    runId,
    turnId,
    taskEpoch: analysisScope.taskEpoch,
  };
}
cancelledRunIdRef.current = null;
analysisRef.current = createAnalysisActivity({
  ...analysisScope,
  analysisId: `analysis-${turnId}`,
});
responseBufferRef.current = createResponseBuffer(analysisScope);
const gitBefore = sessionStoreRef.current.captureGitState();
const agentStateBefore = agentRef.current?.exportSessionState?.() || null;
const {
  activate, clearActive, pauseAnalysis, resumeAnalysis, showAnalysis, updateAnalysis, showPublicAnalysis,
  finishReadBatch, recordReadResult, startRead, planMatchesRun, clearPlanActivity, cleanupCompletedPlan,
} = createSessionActivityController({
  analysisScope, analysisRef, activeRef, setActiveMessage, appendArchived, planRef,
  activeScopeRef, workspacePath: workspace.path, setPlanVisibility, planPanelAfterFinal,
  thinkActivityFromPlan,
});
const completeStreaming = () => {
  const committed = commitResponseBuffer(responseBufferRef.current, analysisScope);
  responseBufferRef.current = committed.state;
  if (!committed.response) return "";
  const content = normalizeStreamText(agent.redactForDisplay(committed.response.content));
  const visibleContent = planningRun ? cleanPlanOutput(content) : content;
  if (!visibleContent) return "";
  if (initialization) {
    runState.finalCommitted = true;
    return visibleContent;
  }
  appendArchived({ id: committed.response.id, type: "answer", content: visibleContent });
  runState.finalCommitted = true;
  cleanupCompletedPlan();
  return visibleContent;
};
const resetStreaming = () => {
  responseBufferRef.current = resetResponseBuffer(responseBufferRef.current, analysisScope);
};
const discardStreaming = () => {
  responseBufferRef.current = discardResponseBuffer(responseBufferRef.current, analysisScope);
};
if (!retryProvider && !internalInput) {
  appendArchived({ id: nextId(), type: "user", content: redactSecrets(input) });
}

const updateUsage = () => {
  const usage = agentRef.current?.contextUsage() || {};
  contextUsageRef.current = usage;
  setContextUsage(usage);
};

const agent = agentRef.current;
agent.setQuestionHandler(request => new Promise(resolve => {
  planningQuestionRef.current = request;
  questionResolverRef.current = {
    kind: planningRun ? "plan-decision" : "question",
    resolve,
    scope: analysisScope,
  };
}));
agent.setPermissionHandler(request => new Promise(resolve => {
  const current = activeScopeRef.current;
  if (
    !current
    || request.runId !== current.runId
    || request.turnId !== current.turnId
    || request.taskEpoch !== current.taskEpoch
    || cancelledRunIdRef.current === request.runId
  ) {
    resolve("");
    return;
  }
  questionResolverRef.current = {
    kind: "permission",
    resolve,
    scope: { runId: request.runId, turnId: request.turnId, taskEpoch: request.taskEpoch },
    callId: request.callId,
  };
}));
try {
  await consumeSessionEvents({
    agent,
    input,
    analysisScope,
    retryProvider,
    approvedPlan,
    initialization,
    runId,
    turnId,
    planningRun,
    appendArchived,
    activeRef,
    analysisRef,
    pauseAnalysis,
    resumeAnalysis,
    showAnalysis,
    updateAnalysis,
    showPublicAnalysis,
    finishReadBatch,
    recordReadResult,
    startRead,
    planMatchesRun,
    clearPlanActivity,
    cleanupCompletedPlan,
    clearActive,
    activate,
    completeStreaming,
    resetStreaming,
    discardStreaming,
    updateUsage,
    responseBufferRef,
    completedRef,
    contextUsageRef,
    cancelledRunIdRef,
    pendingPermissionCallIdRef,
    structuredCallsRef,
    messageQueueRef,
    planRef,
    setContextUsage,
    setModeStatus,
    setPendingQuestion,
    setPlan,
    setPlanVisibility,
    appendResponseDelta,
    analysisActivityMessage,
    analysisEventIsCurrent,
    clearAnalysisActivity,
    clearPublicAnalysisActivity,
    failAnalysisActivity,
    discardResponseBuffer,
    cleanPlanOutput,
    removeAssistantProtocolText,
    removeEmoji,
    EMPTY_PLAN_STATE,
    classifyToolState,
    applyPlanEventState,
    applyPlanUpdateState,
    toolResultFailed,
    isInternalAgentFailure,
    isCompletionClaim,
    nextId,
    planWorkflowRef,
    planningQuestionRef,
    questionResolverRef,
    setExpandedTool,
    setQueuedCount,
    activeScopeRef,
    readFileName,
    thinkActivityFromPlan,
    workspace,
    setActiveMessage,
  }, runState);
} catch (error) {
  discardStreaming();
  finishReadBatch();
  pauseAnalysis();
  analysisRef.current = clearAnalysisActivity(analysisRef.current, analysisScope);
  clearActive();
  const content = removeAssistantProtocolText(agent.redactForDisplay(error?.message || String(error))).trim();
  if (content) {
    runState.fatalError = `Unexpected error: ${content}`;
    appendArchived({ id: nextId(), type: "error", content: runState.fatalError });
  }
} finally {
  updateUsage();
  agentSessionRef.current = agent.exportSessionState?.() || null;
  if (
    planningRun
    && runState.finishedNormally
    && runState.finalCommitted
    && cancelledRunIdRef.current !== runId
  ) {
    setModeStatus({ mode: "plan", status: "drafting" });
    if (planWorkflowRef.current?.planId === runState.planningState?.planId) {
      runState.planningState = planWorkflowRef.current;
    }
    const context = agent.planningContext();
    runState.finalizedPlanningState = finalizePlanMode(runState.planningState, {
      workspace: workspace.path,
      summary: runState.finalResponse,
      relevantFiles: context.relevantFiles,
      steps: runState.latestPlan.length ? runState.latestPlan : context.plan,
    });
    planWorkflowRef.current = runState.finalizedPlanningState;
    runState.planningState = runState.finalizedPlanningState;
    setModeStatus({ mode: "plan", status: "ready" });
  }
  let initializationOutcome = null;
  if (initialization) {
    const initState = initRunRef.current;
    const currentScope = activeScopeRef.current;
    const ownsInitialization = initState.status === "running"
      && initState.runId === runId
      && initState.turnId === turnId
      && initState.taskEpoch === analysisScope.taskEpoch
      && initState.workspaceRoot === initialization.workspaceRoot;
    const isCurrent = ownsInitialization
      && currentScope?.runId === runId
      && currentScope?.turnId === turnId
      && currentScope?.taskEpoch === analysisScope.taskEpoch
      && cancelledRunIdRef.current !== runId;
    if (isCurrent && runState.finishedNormally) {
      initializationOutcome = verifyInitTarget(
        initialization.workspaceRoot,
        initialization.targetPath,
      );
      if (initializationOutcome.ok) {
        await agent.reloadWorkspaceInstructions();
        initRunRef.current = { ...initState, status: "completed" };
      } else {
        initRunRef.current = { ...initState, status: "failed" };
      }
    } else if (ownsInitialization) {
      initRunRef.current = { ...initState, status: "failed" };
    }
  }
  discardStreaming();
  finishReadBatch();
  clearActive();
  const finalPlan = planRef.current;
  const cancelled = cancelledRunIdRef.current === runId;
  if (planMatchesRun(finalPlan) && (cancelled || !runState.finishedNormally)) {
    const status = cancelled ? "cancelled" : "failed";
    if (finalPlan.status !== status || finalPlan.currentStepId || finalPlan.steps.some(step => step.status === "active")) {
      setPlan(normalizePlanState({
        ...finalPlan,
        revision: finalPlan.revision + 1,
        status,
        currentStepId: null,
        steps: finalPlan.steps.map(step => step.status === "active" ? { ...step, status: "failed" } : step),
      }));
    }
    clearPlanActivity();
  } else if (runState.finalCommitted) {
    clearPlanActivity();
    cleanupCompletedPlan();
  }
  if (runState.finishedNormally && analysisRef.current && !planningRun) {
    analysisRef.current = completeAnalysisActivity(analysisRef.current, analysisScope);
    const summary = analysisActivityMessage(analysisRef.current);
    if (analysisRef.current?.status === "completed" && summary?.accumulatedDurationMs > 0) {
      appendArchived(summary);
    }
  }
  analysisRef.current = clearAnalysisActivity(analysisRef.current, analysisScope);
  questionResolverRef.current = null;
  activeScopeRef.current = null;
  setPendingQuestion(null);
  submittingRef.current = false;
  setRunning(false);
  setWorkspaceFiles(listWorkspaceFiles(workspace.path));
  if (initializationOutcome?.ok) {
    appendArchived({
      id: nextId(),
      type: "answer",
      content: "Created AGENTS.md. Review and edit it to match your repository conventions.",
    });
  } else if (initializationOutcome && !initializationOutcome.ok) {
    appendArchived({ id: nextId(), type: "error", content: initializationOutcome.error });
  }
  const runResult = runState.recoverableFailure || runState.handedOffForQueue ? null : terminalRunResult({
    cancelled: cancelledRunIdRef.current === runId,
    completionGaps: agent._executionPolicy?.completionGaps?.() || [],
    fatalError: runState.fatalError,
    finalCommitted: runState.finalCommitted,
    finishedNormally: runState.finishedNormally,
  });
  if (!initialization && !planningRun && runResult?.status === "failed" && runResult.unresolvedIssues.length) {
    appendArchived({
      id: nextId(),
      type: "summary",
      status: "attention",
      unresolvedIssues: runResult.unresolvedIssues,
    });
  }
  const session = currentSessionRef.current;
  if (session?.id === sessionBefore?.id) {
    if (retryProvider) {
      currentSessionRef.current = sessionStoreRef.current.save({
        ...session,
        messages: completedRef.current,
        agentState: agentSessionRef.current,
        savedPlan: runState.latestPlan.map(item => ({ ...item })),
      });
    } else {
      if (session.turns.length === 0) {
        session.title = initialization ? "Create AGENTS.md" : redactSecrets(input).slice(0, 72);
      }
      session.savedPlan = runState.latestPlan.map(item => ({ ...item }));
      currentSessionRef.current = sessionStoreRef.current.recordTurn(session, {
        input,
        before: gitBefore,
        after: sessionStoreRef.current.captureGitState(),
        messages: completedRef.current,
        agentState: agentSessionRef.current,
        agentStateBefore,
      });
    }
  }
  if (!runState.recoverableFailure) agent.clearTurnSecrets(analysisScope);
  if (queuedItemId) {
    const cancelled = cancelledRunIdRef.current === runId && !runState.handedOffForQueue;
    if (cancelled) messageQueueRef.current.cancel(queuedItemId);
    else messageQueueRef.current.complete(queuedItemId);
  }
  const nextQueued = messageQueueRef.current.startNext();
  setQueuedCount(messageQueueRef.current.pendingCount());
  if (nextQueued) {
    planWorkflowRef.current = null;
    queueMicrotask(() => {
      if (messageQueueRef.current.exiting) return;
      submitRef.current?.(nextQueued.rawContent, { queuedItemId: nextQueued.id });
    });
  } else if (runState.finalizedPlanningState) {
    queueMicrotask(() => openPlanApprovalRef.current?.(runState.finalizedPlanningState));
  } else if (approvedPlan) {
    planWorkflowRef.current = null;
    buildStartedPlanIdRef.current = null;
    setModeStatus(null);
  }
}
  };
}
