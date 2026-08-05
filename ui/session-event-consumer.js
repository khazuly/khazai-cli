import { attachFileReferences } from "./file-reference.js";

export async function consumeSessionEvents(context, runState) {
  const { agent, input, analysisScope, retryProvider, approvedPlan, initialization, runId, turnId, planningRun, appendArchived, activeRef, analysisRef, pauseAnalysis, resumeAnalysis, showAnalysis, updateAnalysis, showPublicAnalysis, finishReadBatch, recordReadResult, startRead, planMatchesRun, clearPlanActivity, cleanupCompletedPlan, clearActive, activate, completeStreaming, resetStreaming, discardStreaming, updateUsage, responseBufferRef, completedRef, contextUsageRef, cancelledRunIdRef, pendingPermissionCallIdRef, structuredCallsRef, messageQueueRef, planRef, setContextUsage, setModeStatus, setPendingQuestion, setPlan, setPlanVisibility, appendResponseDelta, analysisActivityMessage, analysisEventIsCurrent, clearAnalysisActivity, clearPublicAnalysisActivity, failAnalysisActivity, discardResponseBuffer, cleanPlanOutput, removeAssistantProtocolText, removeEmoji, EMPTY_PLAN_STATE, classifyToolState, applyPlanEventState, applyPlanUpdateState, toolResultFailed, isInternalAgentFailure, isCompletionClaim, nextId, planWorkflowRef, planningQuestionRef, questionResolverRef, setExpandedTool, setQueuedCount, activeScopeRef, readFileName, thinkActivityFromPlan, workspace, setActiveMessage } = context;
updateUsage();
const agentInput = retryProvider
  ? ""
  : input.trimStart().startsWith("!")
  ? input
  : attachFileReferences(input, workspace.path);
for await (const ev of agent.loop(agentInput, undefined, {
  ...analysisScope,
  retryProvider,
  approvedPlan,
  syntheticContinuation: Boolean(approvedPlan),
})) {
  if (ev.type === "compaction-state") {
    setContextUsage({
      ...(ev.usage || contextUsageRef.current),
      compactionStatus: ev.status,
      compactionStartedAt: ev.startedAt || contextUsageRef.current.compactionStartedAt,
    });
    continue;
  }
  if (ev.type === "context-usage") {
    contextUsageRef.current = ev.usage || {};
    setContextUsage(ev.usage || {});
    continue;
  }
  if (ev.type === "compaction-start") {
    setContextUsage(current => ({ ...current, compactionStatus: "summarizing" }));
    continue;
  }
  if (ev.type === "compaction-end") {
    updateUsage();
    continue;
  }
  if (runState.queueHandoffPending) {
    if (messageQueueRef.current.pendingCount() > 0) {
      runState.handedOffForQueue = true;
      cancelledRunIdRef.current = analysisScope.runId;
      responseBufferRef.current = discardResponseBuffer(responseBufferRef.current, analysisScope);
      setPlan([]);
      agent.abort();
      break;
    }
    runState.queueHandoffPending = false;
  }
  if (cancelledRunIdRef.current === analysisScope.runId) continue;
  if (!analysisEventIsCurrent(ev, analysisScope)) continue;
  if (ev.type === "thinking") {
    if (planningRun) setModeStatus({ mode: "plan", status: "exploring" });
    resetStreaming();
    finishReadBatch();
    if (ev.phase === "continuation") {
      resumeAnalysis();
      continue;
    }
    const currentPlan = planRef.current;
    const scopedPlan = planMatchesRun(currentPlan) ? currentPlan : EMPTY_PLAN_STATE;
    showAnalysis(thinkActivityFromPlan(scopedPlan.steps, ev.phase, scopedPlan.currentStepId));
    continue;
  }

  if (ev.type === "public-activity") {
    showPublicAnalysis(
      ev.toolCallId,
      agent.redactSerializableForDisplay(ev.publicActivity || {}),
    );
    continue;
  }

  if (ev.type === "plan") {
    resetStreaming();
    finishReadBatch();
    pauseAnalysis();
    clearActive();
    const current = planRef.current;
    const next = applyPlanEventState(current, ev);
    if (next === current) continue;
    runState.latestPlan = next.steps;
    setPlan(next);
    setPlanVisibility(next.planId);
    continue;
  }

  if (ev.type === "plan-update") {
    const next = applyPlanUpdateState(planRef.current, ev);
    if (next === planRef.current) continue;
    runState.latestPlan = next.steps;
    setPlan(next);
    const activeStep = next.steps.find(item => item.status === "active");
    if (!activeStep) {
      clearPlanActivity();
    } else if (activeRef.current?.type === "think") {
        updateAnalysis(thinkActivityFromPlan(next.steps, undefined, next.currentStepId));
    }
    continue;
  }

  if (ev.type === "question") {
    resetStreaming();
    finishReadBatch();
    pauseAnalysis();
    if (planningRun) setModeStatus({ mode: "plan", status: "clarifying" });
    setPendingQuestion({
      questionId: ev.questionId,
      question: ev.question,
      context: ev.context,
      options: ev.options,
      allowCustomAnswer: ev.allowCustomAnswer,
      kind: planningRun ? "plan" : "question",
    });
    continue;
  }

  if (ev.type === "permission") {
    resetStreaming();
    pauseAnalysis();
    const currentTool = activeRef.current;
    if (
      currentTool?.callId === ev.callId
      || currentTool?.type === "read-group" && currentTool.callIds?.includes(ev.callId)
    ) {
      activate({ ...currentTool, status: "awaiting-approval" });
    }
    if (pendingPermissionCallIdRef.current === ev.callId) continue;
    pendingPermissionCallIdRef.current = ev.callId;
    setPendingQuestion({
      id: `permission-${ev.callId}`,
      question: ev.action,
      options: ev.options,
      kind: "permission",
      permissionRequest: {
        action: agent.redactForDisplay(ev.action),
        target: agent.redactSerializableForDisplay(ev.target),
        evidence: agent.redactSerializableForDisplay(ev.evidence),
      },
      runId: ev.runId,
      turnId: ev.turnId,
    });
    continue;
  }

  if (ev.type === "tool-part") {
    const part = ev.part;
    if (!part || part.type !== "tool") continue;
    if (planningRun && (part.metadata?.planDenied || part.state?.metadata?.planDenied)) {
      if (activeRef.current?.callId === part.callId) clearActive();
      continue;
    }
    if (part.tool === "question") continue;
    structuredCallsRef.current.add(part.callId);
    if (part.tool === "think") {
      if (part.state.status === "pending" || part.state.status === "running") {
        showPublicAnalysis(
          part.callId,
          agent.redactSerializableForDisplay(part.state.input || {}),
        );
      } else if (part.state.status === "error") {
        analysisRef.current = clearPublicAnalysisActivity(
          analysisRef.current,
          analysisScope,
          part.callId,
        );
        pauseAnalysis();
        clearActive();
      }
      continue;
    }
    if (part.state.status === "pending" || part.state.status === "running") {
      if (approvedPlan) {
        const command = String(part.state.input?.command || "");
        setModeStatus({
          mode: "build",
          status: /\b(?:test|check|lint|build|typecheck)\b/i.test(command)
            ? "verifying"
            : "implementing",
        });
      }
      resetStreaming();
      if (part.tool === "read") {
        startRead(
          part.callId,
          agent.redactSerializableForDisplay(part.state.input || {}),
          part.state.time?.start || Date.now(),
          part.state.status,
        );
        continue;
      }
      finishReadBatch();
      pauseAnalysis();
      if (activeRef.current?.type === "tool" && activeRef.current.callId === part.callId) {
        activate({
          ...activeRef.current,
          args: agent.redactSerializableForDisplay(part.state.input || {}),
          status: part.state.status,
        });
      } else {
        activate({
          id: `tool-${part.callId}`,
          type: "tool",
          callId: part.callId,
          tool: part.tool,
          args: agent.redactSerializableForDisplay(part.state.input || {}),
          done: false,
          status: part.state.status,
          startedAt: part.state.time?.start || Date.now(),
          runId: ev.runId,
          turnId: ev.turnId,
          taskEpoch: ev.taskEpoch,
        });
      }
      continue;
    }
    const safeResult = agent.redactForDisplay(
      part.state.status === "error" ? part.state.error : part.state.output,
    );
    const failed = part.state.status === "error";
    const duration = part.state.time?.end && part.state.time?.start
      ? part.state.time.end - part.state.time.start
      : null;
    if (part.tool === "read") {
      recordReadResult(part.callId, safeResult, failed);
      continue;
    }
    const current = activeRef.current?.callId === part.callId ? activeRef.current : null;
    if (current) clearActive();
    const toolMessageId = `tool-${part.callId}`;
    if (completedRef.current.some(message => message.id === toolMessageId)) continue;
    appendArchived({
      ...(current || {
        id: toolMessageId,
        type: "tool",
        tool: part.tool,
        args: agent.redactSerializableForDisplay(part.state.input || {}),
        runId: ev.runId,
        turnId: ev.turnId,
      }),
      callId: part.callId,
      content: safeResult,
      done: true,
      failed,
      duration,
      resultSize: Buffer.byteLength(safeResult || ""),
      metadata: agent.redactSerializableForDisplay(part.state.metadata || {}),
      expanded: false,
    });
    continue;
  }

  if (ev.type === "tool-call") {
    if (ev.callId && structuredCallsRef.current.has(ev.callId)) continue;
    if (ev.tool === "question") continue;
    resetStreaming();
    if (ev.tool === "think") {
      finishReadBatch();
      showPublicAnalysis(
        ev.callId,
        agent.redactSerializableForDisplay(ev.args || {}),
      );
      continue;
    }
    if (ev.tool === "read") {
      startRead(ev.callId, agent.redactSerializableForDisplay(ev.args || {}));
      continue;
    }
    finishReadBatch();
    pauseAnalysis();
    activate({
      id: `tool-${ev.callId}`,
      type: "tool",
      callId: ev.callId,
      tool: ev.tool,
      args: agent.redactSerializableForDisplay(ev.args || {}),
      done: false,
      status: "pending",
      startedAt: Date.now(),
      runId: ev.runId,
      turnId: ev.turnId,
      taskEpoch: ev.taskEpoch,
    });
    continue;
  }

  if (ev.type === "stream") {
    finishReadBatch();
    pauseAnalysis();
    responseBufferRef.current = appendResponseDelta(
      responseBufferRef.current,
      analysisScope,
      ev.token,
    );
    if (activeRef.current?.type !== "streaming") {
      activate({
        id: `stream-${ev.runId || analysisScope.runId}-${ev.turnId || analysisScope.turnId}-${ev.taskEpoch ?? ""}`,
        type: "streaming",
        runId: ev.runId,
        turnId: ev.turnId,
        taskEpoch: ev.taskEpoch,
      });
    }
    continue;
  }

  if (ev.type === "stream-discard") {
    resetStreaming();
    if (activeRef.current?.type === "streaming") clearActive();
    continue;
  }

  if (ev.type === "stream-commit") {
    finishReadBatch();
    resetStreaming();
    continue;
  }

  if (ev.type === "tool-result") {
    updateUsage();
    if (planningRun && ev.metadata?.planDenied) {
      if (activeRef.current?.callId === ev.callId) clearActive();
      continue;
    }
    if (ev.tool === "think") {
      if (messageQueueRef.current.pendingCount() > 0) runState.queueHandoffPending = true;
      continue;
    }
    if (messageQueueRef.current.pendingCount() > 0) runState.queueHandoffPending = true;
    if (ev.callId && structuredCallsRef.current.has(ev.callId)) {
      if (ev.tool === "read") {
        recordReadResult(ev.callId, agent.redactForDisplay(ev.result), Boolean(ev.failed));
      }
      continue;
    }
    const current = activeRef.current;
    const duration = current?.startedAt ? Date.now() - current.startedAt : null;
    const safeResult = agent.redactForDisplay(ev.result);
    if (isInternalAgentFailure(safeResult)) {
      clearActive();
      continue;
    }
    const resultSize = Buffer.byteLength(safeResult || "");
    const failed = toolResultFailed(safeResult);
    if (ev.tool === "read") {
      recordReadResult(ev.callId, safeResult, failed);
      if (runState.queueHandoffPending) finishReadBatch();
      continue;
    }
    clearActive();
    const toolMessageId = `tool-${ev.callId}`;
    if (completedRef.current.some(message => message.id === toolMessageId)) continue;
    appendArchived(
      current?.type === "tool"
        ? { ...current, content: safeResult, done: true, failed, duration, resultSize, metadata: agent.redactSerializableForDisplay(ev.metadata || {}), expanded: false }
        : {
            id: toolMessageId,
            type: "tool",
            tool: ev.tool,
            args: {},
            content: safeResult,
            done: true,
            failed,
            duration,
            resultSize,
            metadata: agent.redactSerializableForDisplay(ev.metadata || {}),
            expanded: false,
            runId: ev.runId,
            turnId: ev.turnId,
          }
    );
    continue;
  }

  if (ev.type === "steering") continue;

  if (ev.type === "answer" || ev.type === "error") {
    if (isInternalAgentFailure(ev.content)) continue;
    discardStreaming();
    finishReadBatch();
    const rawSafeContent = removeAssistantProtocolText(agent.redactForDisplay(removeEmoji(ev.content))).trim();
    const safeContent = planningRun ? cleanPlanOutput(rawSafeContent) : rawSafeContent;
    const thinkTimeout = ev.type === "error" && /Analysis timed out|timed out/i.test(safeContent);
    const providerFailure = ev.recoverable || /^\[×\]/.test(safeContent);
    if (ev.type === "answer") {
      pauseAnalysis();
      if (activeRef.current?.type === "streaming") clearActive();
      runState.finishedNormally = true;
      runState.finalResponse = safeContent;
    } else if (providerFailure) {
      runState.recoverableFailure = true;
      pauseAnalysis();
      clearActive();
      analysisRef.current = clearAnalysisActivity(analysisRef.current, analysisScope);
    } else if (thinkTimeout) {
      runState.fatalError = "Analysis timed out";
      pauseAnalysis();
      analysisRef.current = failAnalysisActivity(analysisRef.current, analysisScope);
      const timeoutMessage = analysisActivityMessage(analysisRef.current);
      if (timeoutMessage) appendArchived(timeoutMessage);
      analysisRef.current = clearAnalysisActivity(analysisRef.current, analysisScope);
    } else {
      runState.fatalError = safeContent || "The provider failed";
      clearActive();
      analysisRef.current = clearAnalysisActivity(analysisRef.current, analysisScope);
    }
    if (safeContent && !thinkTimeout) {
      if (!initialization) {
        appendArchived({
          id: nextId(),
          type: providerFailure ? "provider-error" : ev.type,
          content: safeContent,
        });
        if (ev.type === "answer") {
          runState.finalCommitted = true;
          cleanupCompletedPlan();
        }
      } else if (ev.type === "answer") {
        runState.finalCommitted = true;
        cleanupCompletedPlan();
      }
    }
    continue;
  }

  if (ev.type === "stream-end") {
    finishReadBatch();
    pauseAnalysis();
    runState.finalResponse = completeStreaming() || runState.finalResponse;
    if (activeRef.current?.type === "think") {
      analysisRef.current = clearAnalysisActivity(analysisRef.current, analysisScope);
      clearActive();
    } else if (activeRef.current?.type === "streaming") {
      clearActive();
    }
    runState.finishedNormally = true;
    updateUsage();
    continue;
  }
}
if (runState.queueHandoffPending && messageQueueRef.current.pendingCount() > 0) {
  runState.handedOffForQueue = true;
  cancelledRunIdRef.current = analysisScope.runId;
  agent.abort();
}
}
