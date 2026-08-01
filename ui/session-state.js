import { useCallback, useEffect, useRef, useState } from "react";
import { EMPTY_PLAN_STATE, normalizePlanState } from "../app/agent/plan.js";
import { listWorkspaceFiles } from "./file-reference.js";
import { UserMessageQueue } from "./user-message-queue.js";

export function useSessionState({ currentSessionRef, initialConfig, workspace, initialMcpTools }) {
const [completedMessages, setCompletedMessages] = useState([]);
const [activeMessage, setActiveMessage] = useState(null);
const [planState, setPlanState] = useState(EMPTY_PLAN_STATE);
const planRef = useRef(EMPTY_PLAN_STATE);
const [visiblePlanId, setVisiblePlanId] = useState(null);
const setPlanVisibility = useCallback(planId => {
  setVisiblePlanId(planId);
}, []);
const setPlan = useCallback(next => {
  const current = planRef.current;
  const value = typeof next === "function" ? next(current) : next;
  const state = Array.isArray(value)
    ? value.length === 0
      ? EMPTY_PLAN_STATE
      : normalizePlanState({ ...current, steps: value })
    : normalizePlanState(value);
  planRef.current = state;
  setPlanState(state);
}, []);
const plan = visiblePlanId === planState.planId ? planState.steps : [];
const [running, setRunning] = useState(false);
const [currentModel, setCurrentModel] = useState(currentSessionRef.current.model);
const [themeName, setThemeName] = useState(initialConfig.current.theme || "system");
const themePreviewRef = useRef(null);
const [workspaceFiles, setWorkspaceFiles] = useState(() => listWorkspaceFiles(workspace.path));
const [sessionKey, setSessionKey] = useState(0);
const [pendingQuestion, setPendingQuestion] = useState(null);
const [expandedTool, setExpandedTool] = useState(null);
const [queuedCount, setQueuedCount] = useState(0);
const [contextUsage, setContextUsage] = useState({});
const [modeStatus, setModeStatus] = useState(null);
const [showSettings, setShowSettings] = useState(false);
const [settingsSection, setSettingsSection] = useState(null);
const initRunRef = useRef({ status: "idle" });
const handleCommandRef = useRef(null);
const [sessionManagerSessions, setSessionManagerSessions] = useState(null);
const contextUsageRef = useRef({});
const agentRef = useRef(null);
const activeRef = useRef(null);
const submittingRef = useRef(false);
const questionResolverRef = useRef(null);
const activeScopeRef = useRef(null);
const responseBufferRef = useRef(null);
const completedRef = useRef([]);
const agentSessionRef = useRef(null);
const mcpToolsRef = useRef(initialMcpTools);
const autoApproveRef = useRef(false);
const pendingPermissionCallIdRef = useRef(null);
const structuredCallsRef = useRef(new Set());
const analysisRef = useRef(null);
const cancelledRunIdRef = useRef(null);
const taskEpochRef = useRef(0);
const submitRef = useRef(null);
const abortRef = useRef(null);
const messageQueueRef = useRef(null);
const planWorkflowRef = useRef(null);
const planningQuestionRef = useRef(null);
const openPlanApprovalRef = useRef(null);
const planActionRef = useRef(null);
const buildStartedPlanIdRef = useRef(null);
const exitStartedRef = useRef(false);
if (!messageQueueRef.current) {
  messageQueueRef.current = new UserMessageQueue(currentSessionRef.current.id);
}
useEffect(() => () => messageQueueRef.current.markExiting(), []);

  return {
    completedMessages,
    setCompletedMessages,
    activeMessage,
    setActiveMessage,
    planState,
    planRef,
    setPlanVisibility,
    setPlan,
    plan,
    running,
    setRunning,
    currentModel,
    setCurrentModel,
    themeName,
    setThemeName,
    themePreviewRef,
    workspaceFiles,
    setWorkspaceFiles,
    sessionKey,
    setSessionKey,
    pendingQuestion,
    setPendingQuestion,
    expandedTool,
    setExpandedTool,
    queuedCount,
    setQueuedCount,
    contextUsage,
    setContextUsage,
    modeStatus,
    setModeStatus,
    showSettings,
    setShowSettings,
    settingsSection,
    setSettingsSection,
    initRunRef,
    handleCommandRef,
    sessionManagerSessions,
    setSessionManagerSessions,
    contextUsageRef,
    agentRef,
    activeRef,
    submittingRef,
    questionResolverRef,
    activeScopeRef,
    responseBufferRef,
    completedRef,
    agentSessionRef,
    mcpToolsRef,
    autoApproveRef,
    pendingPermissionCallIdRef,
    structuredCallsRef,
    analysisRef,
    cancelledRunIdRef,
    taskEpochRef,
    submitRef,
    abortRef,
    messageQueueRef,
    planWorkflowRef,
    planningQuestionRef,
    openPlanApprovalRef,
    planActionRef,
    buildStartedPlanIdRef,
    exitStartedRef,
  };
}
