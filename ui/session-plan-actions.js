import { useCallback } from "react";

function selectedValue(answer, pendingQuestion) {
  if (typeof answer === "object" && answer) return answer;
  return {
    id: "",
    label: String(answer || "").trim(),
    custom: pendingQuestion?.kind === "question-custom",
  };
}

export function usePlanSessionActions(context) {
  const {
    abortRef,
    activeRef,
    activeScopeRef,
    agentRef,
    analysisRef,
    appendArchived,
    cancelledRunIdRef,
    currentSessionRef,
    pendingPermissionCallIdRef,
    pendingQuestion,
    prepareRunInterruption,
    questionResolverRef,
    responseBufferRef,
    sessionStoreRef,
    setActiveMessage,
    setModeStatus,
    setPendingQuestion,
    submittingRef,
    clearPublicAnalysisActivity,
    clearAnalysisActivity,
    nextId,
  } = context;

  const replaceAgentProfile = useCallback(name => {
    if (!["build", "plan"].includes(name)) return;
    agentRef.current?.setMode(name);
    currentSessionRef.current.agent = name;
    currentSessionRef.current.agentState = agentRef.current?.exportSessionState?.() || null;
    currentSessionRef.current = sessionStoreRef.current.save(currentSessionRef.current);
    setModeStatus(name === "plan" ? { mode: "plan", status: "ready" } : null);
  }, [agentRef, currentSessionRef, sessionStoreRef, setModeStatus]);

  const toggleAgentProfile = useCallback(() => {
    const current = currentSessionRef.current.agent;
    replaceAgentProfile(current === "plan" ? "build" : "plan");
  }, [currentSessionRef, replaceAgentProfile]);

  const answerQuestion = useCallback(answer => {
    const pending = questionResolverRef.current;
    const selected = selectedValue(answer, pendingQuestion);
    const value = String(selected.label || "").trim();
    if (!pending || !value) return;
    const current = activeScopeRef.current;
    if (pending.scope && (!current
      || current.runId !== pending.scope.runId
      || current.turnId !== pending.scope.turnId
      || current.taskEpoch !== pending.scope.taskEpoch)) {
      questionResolverRef.current = null;
      pending.resolve("");
      return;
    }
    if (pending.kind === "permission" && pending.callId !== pendingPermissionCallIdRef.current) {
      questionResolverRef.current = null;
      pendingPermissionCallIdRef.current = null;
      setPendingQuestion(null);
      pending.resolve("reject");
      return;
    }
    if (selected.custom && pending.kind === "question") {
      setPendingQuestion(currentQuestion => ({
        ...currentQuestion,
        options: [],
        kind: "question-custom",
        context: "Enter a custom answer below.",
      }));
      return;
    }
    questionResolverRef.current = null;
    setPendingQuestion(null);
    if (pending.kind === "permission") pendingPermissionCallIdRef.current = null;
    if (pending.kind !== "permission" && pending.archive !== false) {
      appendArchived({ id: nextId(), type: "user", content: value });
    }
    pending.resolve(selected.id ? selected : value);
  }, [activeScopeRef, appendArchived, nextId, pendingPermissionCallIdRef, pendingQuestion, questionResolverRef, setPendingQuestion]);

  const cancelQuestion = useCallback(() => {
    const pending = questionResolverRef.current;
    if (!pending) return;
    questionResolverRef.current = null;
    setPendingQuestion(null);
    if (pending.kind === "permission") pendingPermissionCallIdRef.current = null;
    pending.resolve("");
  }, [pendingPermissionCallIdRef, questionResolverRef, setPendingQuestion]);

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
    analysisRef.current = clearAnalysisActivity(analysisRef.current, interruption.scope);
    analysisRef.current = clearPublicAnalysisActivity(analysisRef.current, interruption.scope);
    setPendingQuestion(null);
    agentRef.current?.abort();
    appendArchived({ id: nextId(), type: "answer", content: "Interrupted by user." });
  }, [activeRef, activeScopeRef, agentRef, analysisRef, appendArchived, cancelledRunIdRef, clearAnalysisActivity, clearPublicAnalysisActivity, nextId, pendingPermissionCallIdRef, prepareRunInterruption, questionResolverRef, responseBufferRef, setActiveMessage, setPendingQuestion, submittingRef]);

  abortRef.current = handleAbort;
  return { replaceAgentProfile, toggleAgentProfile, answerQuestion, cancelQuestion, handleAbort };
}
