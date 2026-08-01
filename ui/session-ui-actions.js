import { useCallback } from "react";

export function useSessionUiActions(context) {
  const {
    activeMessage,
    activeRef,
    agentRef,
    analysisRef,
    appendArchived,
    completedMessages,
    completedRef,
    contextUsageRef,
    loadStoredSession,
    removeStoredSessions,
    responseBufferRef,
    sessionKey,
    sessionStoreRef,
    setActiveMessage,
    setCompletedMessages,
    setContextUsage,
    setExpandedTool,
    setPlan,
    setSessionKey,
    setSessionManagerSessions,
    setSettingsSection,
    setShowSettings,
    structuredCallsRef,
    submittingRef,
    nextId,
  } = context;
const handleSettingChange = useCallback((key, value) => {
  if (key === "reasoningEffort" && !submittingRef.current) {
    agentRef.current?.setReasoningEffort(value);
  }
  const refreshed = agentRef.current?.refreshEffectiveSettings?.();
  if (refreshed?.usage) {
    contextUsageRef.current = refreshed.usage;
    setContextUsage(refreshed.usage);
  }
  appendArchived({
    id: nextId(),
    type: "answer",
    content: submittingRef.current
      ? `Setting saved. It will apply to the next model request.`
      : `Setting saved.`,
  });
}, [appendArchived]);

const clearDisplay = useCallback(() => {
  process.stdout.write("\u001b[2J\u001b[H");
  completedRef.current = [];
  activeRef.current = null;
  analysisRef.current = null;
  responseBufferRef.current = null;
  setCompletedMessages([]);
  setActiveMessage(null);
  setPlan([]);
  setExpandedTool(null);
  structuredCallsRef.current.clear();
  setSessionKey(key => key + 1);
}, []);

const staticItems = [
  { id: `banner-${sessionKey}`, type: "banner" },
  ...completedMessages,
];
const displayedActiveMessage = activeMessage;

const handleCloseSettings = useCallback(() => {
  setShowSettings(false);
  setSettingsSection(null);
}, []);

const handleResumeSession = useCallback(id => {
  try {
    const session = sessionStoreRef.current.load(id);
    setSessionManagerSessions(null);
    loadStoredSession(session);
  } catch {
    appendArchived({ id: nextId(), type: "error", content: `Session "${id}" was not found.` });
    setSessionManagerSessions(sessionStoreRef.current.list());
  }
}, [appendArchived, loadStoredSession]);

const handleDeleteSession = useCallback(id => {
  const result = removeStoredSessions([id]);
  if (result.failed) {
    appendArchived({ id: nextId(), type: "error", content: `Session "${id}" could not be removed.` });
  }
  setSessionManagerSessions(sessionStoreRef.current.list());
}, [appendArchived, removeStoredSessions]);

const handleClearSessions = useCallback(() => {
  const sessions = sessionStoreRef.current.list();
  const result = removeStoredSessions(sessions.map(session => session.id));
  if (result.failed) {
    appendArchived({
      id: nextId(),
      type: "error",
      content: `${result.failed} session${result.failed === 1 ? "" : "s"} could not be removed.`,
    });
  }
  setSessionManagerSessions(sessionStoreRef.current.list());
}, [appendArchived, removeStoredSessions]);

  return {
    staticItems,
    displayedActiveMessage,
    handleSettingChange,
    clearDisplay,
    handleCloseSettings,
    handleResumeSession,
    handleDeleteSession,
    handleClearSessions,
  };
}
