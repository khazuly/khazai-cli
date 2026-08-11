function journalPaths(call) {
  if (call.name === "bash") return null;
  if (call.args?.path) return [String(call.args.path)];
  if (call.name !== "apply_patch") return null;
  const paths = [];
  const patch = String(call.args?.patchText || "");
  for (const match of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) paths.push(match[1]);
  for (const match of patch.matchAll(/^\*\*\* Move to: (.+)$/gm)) paths.push(match[1]);
  return paths.length ? paths : null;
}

export function createSessionSubmit(context) {
  const { EMPTY_PLAN_STATE, activeRef, activeScopeRef, agentRef, agentSessionRef, analysisActivityMessage, analysisEventIsCurrent, analysisRef, appendArchived, appendResponseDelta, applyPlanEventState, applyPlanUpdateState, cancelledRunIdRef, classifyToolState, clearAnalysisActivity, clearPublicAnalysisActivity, commitResponseBuffer, completeAnalysisActivity, completedRef, consumeSessionEvents, contextUsageRef, createAnalysisActivity, createResponseBuffer, createSessionActivityController, currentSessionRef, discardResponseBuffer, failAnalysisActivity, initRunRef, listWorkspaceFiles, messageQueueRef, normalizePlanState, pendingPermissionCallIdRef, planRef, questionResolverRef, redactSecrets, removeAssistantProtocolText, removeEmoji, resetResponseBuffer, resolve, responseBufferRef, sessionStoreRef, setActiveMessage, setContextUsage, setExpandedTool, setModeStatus, setPendingQuestion, setPlan, setPlanVisibility, setQueuedCount, setRunning, setWorkspaceFiles, structuredCallsRef, submitRef, submittingRef, taskEpochRef, shouldAppendIssueSummary, terminalRunResult, verifyInitTarget, workspace, nextId, planPanelAfterFinal, normalizeStreamText, toolResultFailed, isInternalAgentFailure, isCompletionClaim, readFileName, thinkActivityFromPlan, setSessionKey, terminalTitle } = context;
  return async (input, options = {}) => {
const retryProvider = Boolean(options.retryProvider);
const approvedPlan = options.approvedPlan || null;
const internalInput = Boolean(options.internalInput);
const resumeRun = options.resumeRun || null;
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
};
const sessionBefore = currentSessionRef.current;
const runId = nextId();
const turnId = options.turnId || `${sessionBefore?.id || "session"}-${runId}`;
if (!retryProvider) taskEpochRef.current++;
const planningRun = currentSessionRef.current.agent === "plan";
const analysisScope = {
  sessionId: sessionBefore?.id,
  runId,
  turnId,
  taskEpoch: taskEpochRef.current,
  mode: planningRun ? "plan" : "build",
};
if (planningRun) {
  setModeStatus({ mode: "plan", status: "exploring" });
} else if (approvedPlan) {
  setModeStatus({ mode: "build", status: "preparing" });
}
activeScopeRef.current = analysisScope;
terminalTitle?.start(analysisScope);
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
let gitBefore = null;
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
  if (!content) return "";
  if (initialization) {
    runState.finalCommitted = true;
    return content;
  }
  appendArchived({ id: committed.response.id, type: "answer", content });
  runState.finalCommitted = true;
  cleanupCompletedPlan();
  return content;
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
let snapshotPaths = new Set();
let snapshotUsesFullState = false;
agent.setBeforeToolExecute?.(call => {
  const paths = journalPaths(call);
  if (!paths) snapshotUsesFullState = true;
  else paths.forEach(path => snapshotPaths.add(path));
  const startedAt = performance.now();
  const captured = sessionStoreRef.current.captureGitState(paths || undefined);
  if (!captured) return;
  gitBefore = gitBefore
    ? { ...gitBefore, files: { ...captured.files, ...gitBefore.files } }
    : captured;
  if (agent._latency) agent._latency.snapshotBeforeMs = performance.now() - startedAt;
});
if (!retryProvider) {
  const startedAt = performance.now();
  agentSessionRef.current = agent.admitRun(input, { ...analysisScope, resumeRun });
  currentSessionRef.current = sessionStoreRef.current.save({
    ...currentSessionRef.current,
    agentState: agentSessionRef.current,
    activeRun: agentSessionRef.current.activeRun,
  });
  if (agent._latency) agent._latency.admissionPersistMs = performance.now() - startedAt;
}
agent.setQuestionHandler(request => new Promise(resolve => {
  questionResolverRef.current = {
    kind: "question",
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
    resumeRun,
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
    questionResolverRef,
    setExpandedTool,
    setQueuedCount,
    activeScopeRef,
    readFileName,
    thinkActivityFromPlan,
    workspace,
    setActiveMessage,
    terminalTitle,
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
  if (planningRun && runState.finishedNormally) setModeStatus({ mode: "plan", status: "ready" });
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
  terminalTitle?.finish(analysisScope);
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
  if (!initialization && !planningRun && shouldAppendIssueSummary(runResult, runState.fatalError)) {
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
      const snapshotAfterStartedAt = performance.now();
      const gitAfter = gitBefore
        ? sessionStoreRef.current.captureGitState(snapshotUsesFullState ? undefined : [...snapshotPaths])
        : null;
      if (agent._latency && gitBefore) agent._latency.snapshotAfterMs = performance.now() - snapshotAfterStartedAt;
      currentSessionRef.current = sessionStoreRef.current.recordTurn(session, {
        input,
        before: gitBefore,
        after: gitAfter,
        messages: completedRef.current,
        agentState: agentSessionRef.current,
        agentStateBefore,
      });
    }
  }
  if (!runState.recoverableFailure) agent.clearTurnSecrets(analysisScope);
  agent.setBeforeToolExecute?.(null);
  if (queuedItemId) {
    const cancelled = cancelledRunIdRef.current === runId && !runState.handedOffForQueue;
    if (cancelled) messageQueueRef.current.cancel(queuedItemId);
    else messageQueueRef.current.complete(queuedItemId);
  }
  const nextQueued = messageQueueRef.current.startNext();
  setQueuedCount(messageQueueRef.current.pendingCount());
  if (nextQueued) {
    queueMicrotask(() => {
      if (messageQueueRef.current.exiting) return;
      submitRef.current?.(nextQueued.rawContent, { queuedItemId: nextQueued.id });
    });
  }
}
  };
}
