import { useCallback } from "react";
import { appendVisibleHistory, recentHistoryWindow } from "./history-window.js";

export function useSessionPersistence(context) {
  const { Agent, activeRef, activeScopeRef, agentRef, agentSessionRef, analysisRef, buildRegistry, buildStartedPlanIdRef, completedRef, currentSessionRef, exitStartedRef, loadConfig, mcpToolsRef, messageQueueRef, nextId, planRef, planWorkflowRef, planningQuestionRef, questionResolverRef, randomUUID, resolve, responseBufferRef, sessionStoreRef, setActiveMessage, setCompletedMessages, setCurrentModel, setExpandedTool, setModeStatus, setPendingQuestion, setPlan, setQueuedCount, setSessionKey, structuredCallsRef, submitRef, taskEpochRef, mcpManager, exit, workspace, autoApproveRef, setContextUsage } = context;
const appendCompleted = useCallback(message => {
  const next = [...completedRef.current, message];
  completedRef.current = next;
  setCompletedMessages(current => appendVisibleHistory(current, message));
  return next;
}, []);

const appendArchived = useCallback(message => {
  return appendCompleted(message);
}, [appendCompleted]);

const requestValue = useCallback((question, options = [], settings = {}) => new Promise(resolveValue => {
  const values = new Map((settings.values || []).map(entry => [entry.label, entry.value]));
  questionResolverRef.current = {
    kind: settings.kind || "command",
    archive: settings.archive !== false,
    resolve: answer => resolveValue(values.get(answer) ?? answer),
    scope: null,
  };
  setPendingQuestion({
    question,
    options,
    secret: Boolean(settings.secret),
    kind: settings.kind || "command",
    context: settings.context,
  });
}), []);

const loadStoredSession = useCallback(session => {
  agentRef.current?.abort();
  activeScopeRef.current = null;
  questionResolverRef.current?.resolve("");
  questionResolverRef.current = null;
  currentSessionRef.current = session;
  agentSessionRef.current = session.agentState || null;
  agentRef.current = new Agent(buildRegistry(workspace.path, mcpToolsRef.current), {
    workspace: workspace.path,
    sessionId: session.id,
    model: session.model,
    agent: session.agent,
    sessionState: session.agentState,
    partHandler: part => {
      sessionStoreRef.current.updatePart(part.sessionId, part, agentRef.current?.activeRunState?.());
    },
  });
  completedRef.current = session.messages || [];
  activeRef.current = null;
  analysisRef.current = null;
  taskEpochRef.current = 0;
  responseBufferRef.current = null;
  planWorkflowRef.current = null;
  planningQuestionRef.current = null;
  buildStartedPlanIdRef.current = null;
  setCompletedMessages(recentHistoryWindow(session.messages));
  setActiveMessage(null);
  setPlan([]);
  setExpandedTool(null);
  setCurrentModel(session.model);
  setModeStatus(session.agent === "plan"
    ? { mode: "plan", status: "ready" }
    : null);
  messageQueueRef.current.reset(session.id);
  setQueuedCount(0);
  structuredCallsRef.current.clear();
  setSessionKey(key => key + 1);
  const interrupted = agentRef.current.interruptedRun();
  if (interrupted) {
    setModeStatus({ mode: interrupted.mode || session.agent || "build", status: "resuming" });
    queueMicrotask(() => submitRef?.current?.(
      "Continue the interrupted task from its saved checkpoint. Do not repeat completed tool calls.",
      { internalInput: true, resumeRun: interrupted },
    ));
  }
}, [workspace.path]);

const freshSession = useCallback(() => {
  const now = new Date().toISOString();
  return {
    version: 6,
    id: randomUUID(),
    workspace: resolve(workspace.path),
    title: "",
    model: loadConfig().model,
    agent: loadConfig().defaultAgent || "build",
    createdAt: now,
    updatedAt: now,
    messages: [],
    agentState: null,
    savedPlan: [],
    parts: [],
    turns: [],
    redo: [],
    permissionMode: "prompt",
    runtime: { version: 4, lastPartAt: null },
    activeRun: null,
  };
}, [workspace.path]);

const removeStoredSessions = useCallback(ids => {
  const selected = new Set(ids);
  const removesCurrent = selected.has(currentSessionRef.current.id);
  const result = sessionStoreRef.current.deleteSessions([...selected]);
  if (removesCurrent && result.failed === 0) loadStoredSession(freshSession());
  return result;
}, [freshSession, loadStoredSession]);

const persistBeforeExit = useCallback(() => {
  const session = currentSessionRef.current;
  agentRef.current?.markRunInterrupted?.();
  const agentState = agentRef.current?.exportSessionState?.() || agentSessionRef.current;
  currentSessionRef.current = sessionStoreRef.current.save({
    ...session,
    messages: completedRef.current,
    agentState,
    activeRun: agentState?.activeRun || null,
    savedPlan: planRef.current.steps.map(item => ({ ...item })),
  });
}, []);

const performExit = useCallback(async save => {
  if (exitStartedRef.current) return;
  exitStartedRef.current = true;
  messageQueueRef.current.markExiting();
  if (save) {
    try {
      persistBeforeExit();
    } catch {
      exitStartedRef.current = false;
      appendArchived({ id: nextId(), type: "error", content: "The session could not be saved. Exit was cancelled." });
      return;
    }
  }
  agentRef.current?.abort();
  activeScopeRef.current = null;
  responseBufferRef.current = null;
  questionResolverRef.current?.resolve("");
  questionResolverRef.current = null;
  try { await mcpManager?.shutdown?.(); } catch {}
  exit();
}, [appendArchived, exit, mcpManager, persistBeforeExit]);

  return { appendCompleted, appendArchived, requestValue, loadStoredSession, freshSession, removeStoredSessions, persistBeforeExit, performExit };
}
