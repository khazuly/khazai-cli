import { createElement as h } from "react";
import { useRef, useCallback, useEffect } from "react";
import { useApp } from "ink";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Agent } from "../app/agent.js";
import { PermissionService } from "../app/permission.js";
import { SessionStore } from "../app/session-store.js";
import { loadAgentProfiles } from "../app/agent-profiles.js";
import { listSkills } from "../app/skills.js";
import { lspStatus } from "../app/lsp.js";
import {
  configuredModels,
  loadConfig,
  saveModel,
  saveProvider,
  saveReasoningEffort,
  saveTheme,
  subscribeConfig,
} from "../config/index.js";
import { saveProviderCredential } from "../lib/auth.js";
import { loginCodex } from "../lib/codex-auth.js";
import { listModels } from "../lib/llm.js";
import { formatCommandHelp } from "./commands.js";
import { classifyToolState } from "./tool-presentation.js";
import { removeAssistantProtocolText, removeEmoji } from "../lib/assistant-text.js";
import { redactSecrets } from "../lib/secrets.js";
import { prepareInit, verifyInitTarget } from "../app/init.js";
import { listWorkspaceFiles } from "./file-reference.js";
import { EMPTY_PLAN_STATE, normalizePlanState } from "../app/agent/plan.js";
import { formatSessionList } from "./components/session-manager.js";
import { formatUsageReport } from "./context-usage.js";
import { manageMcpCommand } from "./mcp-command.js";
import {
  analysisActivityMessage,
  analysisEventIsCurrent,
  clearAnalysisActivity,
  clearPublicAnalysisActivity,
  completeAnalysisActivity,
  createAnalysisActivity,
  failAnalysisActivity,
} from "./analysis-activity.js";
import { createSessionActivityController } from "./session-activity-controller.js";
import { consumeSessionEvents } from "./session-event-consumer.js";
import { createSessionSubmit } from "./session-submit.js";
import { usePlanSessionActions } from "./session-plan-actions.js";
import { useSessionPersistence } from "./session-persistence.js";
import { useSessionUiActions } from "./session-ui-actions.js";
import { SessionView } from "./session-view.js";
import { useSessionState } from "./session-state.js";
import {
  appendResponseDelta,
  commitResponseBuffer,
  createResponseBuffer,
  discardResponseBuffer,
  prepareRunInterruption,
  resetResponseBuffer,
  shouldAppendIssueSummary,
  terminalRunResult,
} from "./session-runtime.js";
import { handlePermissionCommand } from "./session-commands.js";
import { PRIMARY_SESSION_COMMANDS, handlePrimarySessionCommand } from "./session-command-primary.js";
import { handleSecondarySessionCommand } from "./session-command-secondary.js";
export { streamViewportText } from "./stream-viewport.js";
import {
  applyPlanEventState, applyPlanUpdateState, buildRegistry, displayModel, formatInteractiveQuestion,
  isCompletionClaim, isInternalAgentFailure, nextId, normalizeStreamText, planPanelAfterFinal,
  readFileName, thinkActivityFromPlan, toolResultFailed,
} from "./session-helpers.js";
export { applyPlanEventState, applyPlanUpdateState, formatInteractiveQuestion, normalizeStreamText, planPanelAfterFinal, toolResultFailed, isInternalAgentFailure, isCompletionClaim } from "./session-helpers.js";
export function Session({ workspace, mcpManager = null, initialMcpTools = [] }) {
  const { exit } = useApp();
  const initialConfig = useRef(loadConfig());
  const sessionStoreRef = useRef(null);
  const currentSessionRef = useRef(null);
  if (!sessionStoreRef.current) {
    sessionStoreRef.current = new SessionStore(workspace.path);
    currentSessionRef.current = sessionStoreRef.current.create({
      model: initialConfig.current.model,
      agent: initialConfig.current.defaultAgent || "build",
    });
  }
  const {
    completedMessages, setCompletedMessages, activeMessage, setActiveMessage,
    planState, planRef, setPlanVisibility, setPlan, plan,
    running, setRunning, currentModel,
    setCurrentModel, themeName, setThemeName, themePreviewRef,
    workspaceFiles, setWorkspaceFiles, sessionKey, setSessionKey,
    pendingQuestion, setPendingQuestion, expandedTool, setExpandedTool,
    queuedCount, setQueuedCount, contextUsage, setContextUsage,
    modeStatus, setModeStatus, showSettings, setShowSettings,
    settingsSection, setSettingsSection, initRunRef, handleCommandRef,
    sessionManagerSessions, setSessionManagerSessions, contextUsageRef, agentRef,
    activeRef, submittingRef, questionResolverRef, activeScopeRef,
    responseBufferRef, completedRef, agentSessionRef, mcpToolsRef,
    autoApproveRef, pendingPermissionCallIdRef, structuredCallsRef, analysisRef,
    cancelledRunIdRef, taskEpochRef, submitRef, abortRef,
    messageQueueRef, planWorkflowRef, planningQuestionRef, openPlanApprovalRef,
    planActionRef, buildStartedPlanIdRef, exitStartedRef,
  } = useSessionState({ currentSessionRef, initialConfig, workspace, initialMcpTools });
  if (!agentRef.current) {
    agentRef.current = new Agent(buildRegistry(workspace.path, mcpToolsRef.current), {
      workspace: workspace.path,
      sessionId: currentSessionRef.current.id,
      model: currentSessionRef.current.model,
      agent: currentSessionRef.current.agent,
      sessionState: currentSessionRef.current.agentState,
      autoApprove: autoApproveRef.current,
      partHandler: part => {
        sessionStoreRef.current.updatePart(part.sessionId, part, agentRef.current?.activeRunState?.());
      },
    });
  }
  useEffect(() => {
    if (!mcpManager?.subscribe) return undefined;
    let active = true;
    const unsubscribe = mcpManager.subscribe(async tools => {
      if (!active) return;
      mcpToolsRef.current = tools;
      await agentRef.current?.replaceRegistry(buildRegistry(workspace.path, tools));
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [mcpManager, workspace.path]);
  useEffect(() => {
    const usage = agentRef.current?.contextUsage() || {};
    contextUsageRef.current = usage;
    setContextUsage(usage);
  }, [sessionKey]);
  useEffect(() => subscribeConfig(event => {
    if (event.reason === "theme" && themePreviewRef.current === null) {
      setThemeName(loadConfig(workspace.path).theme);
    }
    if (event.reason === `model-settings:${currentModel}`) {
      const refreshed = agentRef.current?.refreshEffectiveSettings?.();
      if (refreshed?.usage) {
        contextUsageRef.current = refreshed.usage;
        setContextUsage(refreshed.usage);
      }
    }
  }), [currentModel, workspace.path]);
  const {
    appendCompleted, appendArchived, requestValue, loadStoredSession, freshSession,
    removeStoredSessions, persistBeforeExit, performExit,
  } = useSessionPersistence({
    Agent,
    activeRef,
    activeScopeRef,
    agentRef,
    agentSessionRef,
    analysisRef,
    buildRegistry,
    buildStartedPlanIdRef,
    completedRef,
    currentSessionRef,
    exitStartedRef,
    loadConfig,
    mcpToolsRef,
    messageQueueRef,
    nextId,
    planRef,
    planWorkflowRef,
    planningQuestionRef,
    questionResolverRef,
    randomUUID,
    resolve,
    responseBufferRef,
    sessionStoreRef,
    setActiveMessage,
    setCompletedMessages,
    setCurrentModel,
    setExpandedTool,
    setModeStatus,
    setPendingQuestion,
    setPlan,
    setQueuedCount,
    setSessionKey,
    structuredCallsRef,
    submitRef,
    taskEpochRef,
    mcpManager,
    exit,
    workspace,
    autoApproveRef,
    setContextUsage,
  });
  const handleCommand = useCallback(async (cmd, arg) => {
    const commandContext = {
      Agent,
      PermissionService,
      abortRef,
      agentRef,
      appendArchived,
      autoApproveRef,
      buildRegistry,
      buildStartedPlanIdRef,
      completedRef,
      configuredModels,
      contextUsageRef,
      currentModel,
      currentSessionRef,
      displayModel,
      formatCommandHelp,
      formatSessionList,
      formatUsageReport,
      handlePermissionCommand,
      initRunRef,
      listModels,
      listSkills,
      loadAgentProfiles,
      loadConfig,
      loadStoredSession,
      loginCodex,
      lspStatus,
      manageMcpCommand,
      mcpToolsRef,
      messageQueueRef,
      pendingQuestion,
      performExit,
      planRef,
      planWorkflowRef,
      planningQuestionRef,
      prepareInit,
      removeStoredSessions,
      requestValue,
      resolve,
      running,
      saveModel,
      saveProvider,
      saveProviderCredential,
      saveReasoningEffort,
      saveTheme,
      sessionManagerSessions,
      sessionStoreRef,
      setContextUsage,
      setCurrentModel,
      setExpandedTool,
      setModeStatus,
      setQueuedCount,
      setSessionManagerSessions,
      setSettingsSection,
      setShowSettings,
      setThemeName,
      showSettings,
      submitRef,
      submittingRef,
      themePreviewRef,
      workspace,
      nextId,
      randomUUID,
      setCompletedMessages,
      setActiveMessage,
      setPlanVisibility,
      setSessionKey,
      responseBufferRef,
      activeScopeRef,
    };
    if (PRIMARY_SESSION_COMMANDS.has(cmd)) {
      return handlePrimarySessionCommand(commandContext, cmd, arg);
    }
    return handleSecondarySessionCommand(commandContext, cmd, arg);
  }, [
    appendArchived,
    currentModel,
    loadStoredSession,
    mcpManager,
    pendingQuestion,
    performExit,
    removeStoredSessions,
    requestValue,
    sessionManagerSessions,
    showSettings,
    workspace.path,
  ]);
  handleCommandRef.current = handleCommand;
  const handleThemePreview = useCallback((cmd, value) => {
    if (cmd !== "/theme") return;
    if (themePreviewRef.current === null) {
      themePreviewRef.current = themeName;
    }
    if (value !== themeName) {
      setThemeName(value);
    }
  }, [themeName]);
  const handleThemeExitSub = useCallback((cmd) => {
    if (cmd !== "/theme" || themePreviewRef.current === null) return;
    setThemeName(themePreviewRef.current);
    themePreviewRef.current = null;
  }, []);
  const submit = useCallback(createSessionSubmit({
    EMPTY_PLAN_STATE,
    activeRef,
    activeScopeRef,
    agentRef,
    agentSessionRef,
    analysisActivityMessage,
    analysisEventIsCurrent,
    analysisRef,
    appendArchived,
    appendResponseDelta,
    applyPlanEventState, applyPlanUpdateState,
    buildStartedPlanIdRef,
    cancelledRunIdRef,
    classifyToolState,
    clearAnalysisActivity,
    clearPublicAnalysisActivity,
    commitResponseBuffer,
    completeAnalysisActivity,
    completedRef,
    consumeSessionEvents,
    contextUsageRef,
    createAnalysisActivity,
    createResponseBuffer,
    createSessionActivityController,
    currentSessionRef,
    discardResponseBuffer,
    failAnalysisActivity,
    initRunRef,
    listWorkspaceFiles,
    messageQueueRef,
    normalizePlanState,
    pendingPermissionCallIdRef,
    planRef,
    planWorkflowRef,
    planningQuestionRef,
    questionResolverRef,
    redactSecrets,
    removeAssistantProtocolText,
    removeEmoji,
    resetResponseBuffer,
    resolve,
    responseBufferRef,
    sessionStoreRef,
    setActiveMessage,
    setContextUsage,
    setExpandedTool,
    setModeStatus,
    setPendingQuestion,
    setPlan,
    setPlanVisibility,
    setQueuedCount,
    setRunning,
    setWorkspaceFiles,
    structuredCallsRef,
    submitRef,
    submittingRef,
    taskEpochRef,
    shouldAppendIssueSummary,
    terminalRunResult,
    verifyInitTarget,
    workspace,
    nextId,
    planPanelAfterFinal,
    normalizeStreamText,
    toolResultFailed,
    isInternalAgentFailure,
    isCompletionClaim,
    readFileName,
    thinkActivityFromPlan,
    setSessionKey,
  }), [appendArchived]);
  submitRef.current = submit;
  const handlePromptSubmit = useCallback((input, options) => submit(input, options), [submit]);
  const {
    toggleAgentProfile, answerQuestion, cancelQuestion, handleAbort,
  } = usePlanSessionActions({
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
  });
  const {
    staticItems, displayedActiveMessage,
    handleSettingChange, clearDisplay, handleCloseSettings,
    handleResumeSession, handleDeleteSession, handleClearSessions,
  } = useSessionUiActions({
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
  });
  return h(SessionView, {
    themeName,
    sessionKey,
    staticItems,
    currentModel,
    workspace,
    currentSessionRef,
    autoApproveRef,
    displayedActiveMessage,
    expandedTool,
    running,
    completedMessages,
    activeMessage,
    pendingQuestion,
    plan,
    planState,
    sessionManagerSessions,
    handleResumeSession,
    handleDeleteSession,
    handleClearSessions,
    setSessionManagerSessions,
    showSettings,
    settingsSection,
    handleCloseSettings,
    handleSettingChange,
    queuedCount,
    modeStatus,
    contextUsage,
    activeScopeRef,
    answerQuestion,
    handlePromptSubmit,
    handleCommand,
    clearDisplay,
    handleAbort,
    messageQueueRef,
    cancelQuestion,
    workspaceFiles,
    handleThemePreview,
    handleThemeExitSub,
    toggleAgentProfile,
  });
}
