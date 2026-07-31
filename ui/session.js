import { createElement as h } from "react";
import { useState, useRef, useCallback, useEffect } from "react";
import { Box, Static, useApp } from "ink";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { Agent } from "../app/agent.js";
import { PermissionService } from "../app/permission.js";
import { Registry } from "../app/registry.js";
import { SessionStore } from "../app/session-store.js";
import { builtinTools } from "../app/builtin-tools.js";
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
import { COMMANDS, canonicalCommand, formatCommandHelp } from "./commands.js";
import { SettingsMenu } from "./components/settings-menu.js";
import { Banner } from "./components/banner.js";
import { MessageList } from "./components/message-list.js";
import { PlanList } from "./components/plan-list.js";
import { SessionFooter } from "./components/session-footer.js";
import { EmptyState } from "./components/empty-state.js";
import { normalizeVerticalWhitespace } from "./text-layout.js";
import { classifyToolState } from "./tool-presentation.js";
import { removeAssistantProtocolText, removeEmoji } from "../lib/assistant-text.js";
import { redactSecrets } from "../lib/secrets.js";
import { writeAtomicFile } from "../lib/init-generator.js";
import {
  INIT_TOOLS,
  buildInitTaskPrompt,
  collectInitEvidence,
  prepareInitPreview,
} from "../lib/init-task.js";
import { ThemeProvider } from "./theme.js";
import { attachFileReferences, listWorkspaceFiles } from "./file-reference.js";
import { formatQueuedMessages, UserMessageQueue } from "./user-message-queue.js";
import { InitPrompt } from "./components/init-prompt.js";
import { formatSessionList, SessionManager } from "./components/session-manager.js";
import { formatUsageReport } from "./context-usage.js";
import { manageMcpCommand } from "./mcp-command.js";
import {
  PLAN_ACTIONS,
  REVALIDATION_ACTIONS,
  approvePlanMode,
  approvedPlanRequest,
  changedPlanFiles,
  createPlanModeState,
  finalizePlanMode,
  recordPlanDecision,
  refreshPlanSnapshots,
} from "../app/plan-mode.js";
import {
  analysisActivityMessage,
  analysisEventIsCurrent,
  clearAnalysisActivity,
  clearPublicAnalysisActivity,
  completeAnalysisActivity,
  createAnalysisActivity,
  failAnalysisActivity,
  pauseAnalysisActivity,
  startAnalysisActivity,
  updateAnalysisActivity,
  updatePublicAnalysisActivity,
} from "./analysis-activity.js";
import {
  appendResponseDelta,
  commitResponseBuffer,
  createResponseBuffer,
  discardResponseBuffer,
  permissionModeCommand,
  prepareRunInterruption,
  resetResponseBuffer,
  terminalRunResult,
} from "./session-runtime.js";
export { streamViewportText } from "./stream-viewport.js";

const MODEL_LABELS = { "auto-free": "Auto (free)" };
const displayModel = model => MODEL_LABELS[model] || model;

function buildRegistry(workspace, mcpTools = []) {
  const r = new Registry();
  for (const tool of [...builtinTools(workspace), ...mcpTools].filter(Boolean)) r.register(tool);
  return r;
}

let msgId = 0;
function nextId() { return `m${++msgId}`; }

function readFileName(args) {
  const parts = String(args?.path || "").split("/").filter(Boolean);
  return parts.at(-1) || String(args?.path || "");
}

function thinkActivityFromPlan(plan, phase) {
  const items = Array.isArray(plan) ? plan : [];
  const activeIndex = items.findIndex(item => item.status === "in_progress" || item.status === "running" || item.status === "active");
  if (activeIndex >= 0) {
    return {
      text: removeEmoji(items[activeIndex].text || items[activeIndex].content || items[activeIndex].title || items[activeIndex].description || "Analyzing the execution context").trim(),
      step: items.length > 1 ? `Step ${activeIndex + 1} of ${items.length}` : null,
    };
  }
  const pendingIndex = items.findIndex(item => !item.status || item.status === "pending");
  if (pendingIndex >= 0) {
    return {
      text: removeEmoji(items[pendingIndex].text || items[pendingIndex].content || items[pendingIndex].title || items[pendingIndex].description || "Analyzing the execution context").trim(),
      step: items.length > 1 ? `Step ${pendingIndex + 1} of ${items.length}` : null,
    };
  }
  const text = phase === "continuation"
    ? "Inspecting continuation after tool results"
    : phase === "implementation"
      ? "Preparing the implementation"
      : "Analyzing the execution context";
  return { text, step: null };
}

export function normalizeStreamText(text) {
  return normalizeVerticalWhitespace(removeAssistantProtocolText(removeEmoji(text)));
}

export function toolResultFailed(result) {
  return classifyToolState(result, true) === "failed";
}

export function isInternalAgentFailure(value) {
  return /(?:could not|couldn't|cannot)\s+parse\s+(?:the\s+)?response|invalid\s+tool\s+call|malformed\s+json|schema\s+validation|missing\s+evidence|required\s+execution\s+evidence|successful\s+workspace\s+change|acceptance\s+criteria|evidence\s+gap|\bstopped\b|\bblocked\b|\bdenied\b|safety\s+violation/i.test(String(value || ""));
}

export function isCompletionClaim(value) {
  return !/(?:task is not complete|not complete|unable to complete|failed|error|missing evidence)/i.test(String(value || ""));
}

export function formatInteractiveQuestion(question, options = []) {
  const lines = [removeEmoji(question).trim()];
  options.filter(Boolean).forEach((option, index) => {
    const label = typeof option === "string" ? option : option.label;
    lines.push(`${index + 1}. ${removeEmoji(label)}`);
  });
  return lines.filter(Boolean).join("\n");
}

export function mergeExistingContent(existing, generated) {
  if (!existing) return generated;

  const genSections = parseSections(generated);
  const existingSections = parseSections(existing);
  const merged = [];
  const seenHeadings = new Set();

  for (const [heading, body] of genSections) {
    merged.push(heading);
    merged.push("");
    for (const line of body) merged.push(line);
    if (!body.join("").trim()) merged.push("");
    seenHeadings.add(heading.toLowerCase().trim());
  }

  for (const [heading, body] of existingSections) {
    const key = heading.toLowerCase().trim();
    if (seenHeadings.has(key)) continue;
    merged.push(heading);
    merged.push("");
    for (const line of body) merged.push(line);
    if (!body.join("").trim()) merged.push("");
  }

  return merged.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function parseSections(content) {
  const lines = content.split("\n");
  const sections = [];
  let currentHeading = null;
  let currentBody = [];
  for (const line of lines) {
    const heading = line.match(/^# /);
    if (heading) {
      if (currentHeading) sections.push([currentHeading, currentBody]);
      currentHeading = line;
      currentBody = [];
    } else if (currentHeading) {
      currentBody.push(line);
    }
  }
  if (currentHeading) sections.push([currentHeading, currentBody]);
  return sections;
}

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
  const [completedMessages, setCompletedMessages] = useState([]);
  const [activeMessage, setActiveMessage] = useState(null);
  const [plan, setPlanState] = useState([]);
  const planRef = useRef([]);
  const setPlan = useCallback(next => {
    setPlanState(prev => {
      const value = typeof next === "function" ? next(prev) : next;
      planRef.current = value;
      return value;
    });
  }, []);
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
  const [showInitPrompt, setShowInitPrompt] = useState(false);
  const [initState, setInitState] = useState(null);
  const initStateRef = useRef(null);
  const initGenerationRef = useRef(0);
  const initAwaitingInstructionRef = useRef(false);
  const initRegenerateRef = useRef(null);
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

  if (!agentRef.current) {
    agentRef.current = new Agent(buildRegistry(workspace.path, mcpToolsRef.current), {
      workspace: workspace.path,
      sessionId: currentSessionRef.current.id,
      model: currentSessionRef.current.model,
      agent: currentSessionRef.current.agent,
      sessionState: currentSessionRef.current.agentState,
      autoApprove: autoApproveRef.current,
      partHandler: part => sessionStoreRef.current.updatePart(part.sessionId, part),
    });
  }
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

  const appendCompleted = useCallback(message => {
    const next = [...completedRef.current, message];
    completedRef.current = next;
    setCompletedMessages(next);
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
    autoApproveRef.current = session.permissionMode === "allow-all";
    agentRef.current = new Agent(buildRegistry(workspace.path, mcpToolsRef.current), {
      workspace: workspace.path,
      sessionId: session.id,
      model: session.model,
      agent: session.agent,
      sessionState: session.agentState,
      autoApprove: session.permissionMode === "allow-all",
      partHandler: part => sessionStoreRef.current.updatePart(part.sessionId, part),
    });
    completedRef.current = session.messages || [];
    activeRef.current = null;
    analysisRef.current = null;
    taskEpochRef.current = 0;
    responseBufferRef.current = null;
    planWorkflowRef.current = null;
    planningQuestionRef.current = null;
    buildStartedPlanIdRef.current = null;
    setCompletedMessages(session.messages || []);
    setActiveMessage(null);
    setPlan(Array.isArray(session.savedPlan) ? session.savedPlan.map(item => ({ ...item })) : []);
    setExpandedTool(null);
    setCurrentModel(session.model);
    setModeStatus(session.agent === "plan"
      ? { mode: "plan", status: "reviewing" }
      : null);
    messageQueueRef.current.reset(session.id);
    setQueuedCount(0);
    structuredCallsRef.current.clear();
    setSessionKey(key => key + 1);
  }, [workspace.path]);

  const freshSession = useCallback(() => {
    const now = new Date().toISOString();
    return {
      version: 4,
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
      runtime: { version: 2, lastPartAt: null },
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
    const agentState = agentRef.current?.exportSessionState?.() || agentSessionRef.current;
    currentSessionRef.current = sessionStoreRef.current.save({
      ...session,
      messages: completedRef.current,
      agentState,
      savedPlan: planRef.current.map(item => ({ ...item })),
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

  const runBasicInit = useCallback(async (arg = "") => {
    const { InitGenerator } = await import("../lib/init-generator.js");
    const generator = new InitGenerator(workspace.path);
    const root = generator.detectWorkspace();

    if (!root) {
      appendArchived({ id: nextId(), type: "error", content: "Could not resolve workspace root." });
      return;
    }

    const inspection = generator.inspect();
    const content = generator.generate();
    const validation = generator.validate(content);

    if (!validation.valid) {
      appendArchived({ id: nextId(), type: "error", content: `AGENTS.md could not be generated: ${validation.error}` });
      return;
    }

    const existingPath = join(root, "AGENTS.md");
    const fileExists = existsSync(existingPath);
    const existingContent = fileExists ? readFileSync(existingPath, "utf-8") : null;
    const sectionCount = (content.match(/^# /gm) || []).length || 0;
    const generationId = ++initGenerationRef.current;

    const open = state => {
      initStateRef.current = state;
      setInitState(state);
      setShowInitPrompt(true);
    };

    if (!fileExists) {
      open({
        mode: "create",
        workspaceRoot: root,
        sectionCount,
        inspectedCount: (inspection.inspectedFiles || []).length,
        wordCount: content.split(/\s+/).filter(Boolean).length,
        previewContent: content,
        proposedContent: content,
        existingPath,
        warnings: [],
        generator,
        generationId,
        evidence: null,
      });
      return;
    }

    const merged = mergeExistingContent(existingContent, content);
    if (merged === existingContent) {
      appendArchived({ id: nextId(), type: "answer", content: "AGENTS.md is already up to date." });
      return;
    }
    open({
      mode: String(arg || "").includes("--force") ? "replaceConfirm" : "update",
      workspaceRoot: root,
      sectionCount,
      inspectedCount: (inspection.inspectedFiles || []).length,
      wordCount: content.split(/\s+/).filter(Boolean).length,
      previewContent: content,
      proposedContent: merged,
      existingContent,
      existingPath,
      warnings: [],
      generator,
      generationId,
      evidence: null,
    });
  }, [appendArchived, workspace.path]);

  const handleCommand = useCallback(async (cmd, arg) => {
    if (initAwaitingInstructionRef.current && cmd !== "/init") {
      initAwaitingInstructionRef.current = false;
      initRegenerateRef.current = null;
    }
    if (cmd === "/exit") {
      if (pendingQuestion || showInitPrompt || showSettings || sessionManagerSessions) {
        appendArchived({ id: nextId(), type: "error", content: "Close the active confirmation or manager before exiting." });
        return;
      }
      const queued = messageQueueRef.current.pendingCount();
      const unsaved = submittingRef.current
        || completedRef.current.length !== (currentSessionRef.current.messages || []).length;
      if (submittingRef.current || queued > 0 || unsaved) {
        const action = await requestValue(
          "Exit KhazAI?",
          ["Cancel", "Save and exit", "Exit without saving"],
          {
            archive: false,
            kind: "mcp",
            values: [
              { label: "Cancel", value: "cancel" },
              { label: "Save and exit", value: "save" },
              { label: "Exit without saving", value: "discard" },
            ],
            context: [
              `Active run       ${submittingRef.current ? "Yes" : "No"}`,
              `Queued messages  ${queued}`,
              `Unsaved changes  ${unsaved ? "Yes" : "No"}`,
            ].join("\n"),
          },
        );
        if (action === "cancel" || !action) return;
        await performExit(action === "save");
        return;
      }
      await performExit(true);
      return;
    }
    if (cmd === "/queue") {
      if (String(arg || "").trim().toLowerCase() === "clear") {
        const cleared = messageQueueRef.current.clearPending();
        setQueuedCount(messageQueueRef.current.pendingCount());
        appendArchived({
          id: nextId(),
          type: "answer",
          content: cleared
            ? `Cleared ${cleared} queued message${cleared === 1 ? "" : "s"}.`
            : "No queued messages to clear.",
        });
        return;
      }
      appendArchived({
        id: nextId(),
        type: "answer",
        content: formatQueuedMessages(messageQueueRef.current.pending()),
      });
      return;
    }
    if (cmd === "/cancel") {
      abortRef.current?.();
      return;
    }
    if (cmd === "/init") {
      const lowerArg = String(arg || "").trim().toLowerCase();
      if (showInitPrompt || initStateRef.current) {
        appendArchived({
          id: nextId(),
          type: "error",
          content: "Close the active AGENTS.md preview first.",
        });
        return;
      }
      initAwaitingInstructionRef.current = false;

      if (lowerArg === "basic") {
        runBasicInit(lowerArg);
        return;
      }

      if (submittingRef.current) {
        appendArchived({
          id: nextId(),
          type: "error",
          content: "This command is unavailable while a tool is running.",
        });
        return;
      }

      const kind = lowerArg === "preview"
        ? "preview"
        : lowerArg === "update"
          ? "update"
          : lowerArg === "--force"
            ? "force"
            : "default";
      const baseline = collectInitEvidence(workspace.path);
      if (!baseline.workspaceRoot) {
        appendArchived({ id: nextId(), type: "error", content: "Could not resolve workspace root." });
        return;
      }
      return submitRef.current?.(buildInitTaskPrompt({ baseline }), {
        internalInput: true,
        initTask: { kind, baseline },
      });
    }
    if (
      submittingRef.current
      && !["/help", "/details", "/theme", "/setting", "/sessions", "/usage"].includes(cmd)
    ) {
      appendArchived({
        id: nextId(),
        type: "error",
        content: "This command is unavailable while a tool is running.",
      });
      return;
    }
    if (cmd === "/retry") {
      if (!agentRef.current?.hasRecoverableProviderRequest?.()) {
        appendArchived({
          id: nextId(),
          type: "error",
          content: "No recoverable model request is available.",
        });
        return;
      }
      return submitRef.current?.("", { retryProvider: true });
    }
    if (cmd === "/allow-all" || cmd === "/auto") {
      const requested = cmd === "/auto" && !String(arg || "").trim()
        ? (autoApproveRef.current ? "off" : "on")
        : arg;
      const result = permissionModeCommand(
        requested,
        autoApproveRef.current ? "allow-all" : "prompt",
      );
      if (result.error) {
        appendArchived({ id: nextId(), type: "error", content: result.error });
        return;
      }
      autoApproveRef.current = result.mode === "allow-all";
      if (String(requested || "").trim().toLowerCase() !== "status") {
        agentRef.current?.setAutoApprove(autoApproveRef.current);
        currentSessionRef.current.permissionMode = result.mode;
        currentSessionRef.current = sessionStoreRef.current.save(currentSessionRef.current);
      }
      appendArchived({
        id: nextId(),
        type: "answer",
        content: result.message,
      });
      return;
    }
    const chooseModel = async requested => {
      const models = configuredModels();
      const choices = models.map(model => ({ label: displayModel(model), value: model }));
      const selected = requested || await requestValue("Select a model", choices.map(choice => choice.label), { values: choices });
      if (!selected || !models.includes(selected)) {
        appendArchived({ id: nextId(), type: "error", content: `Model "${selected}" is not configured.` });
        return;
      }
      saveModel(selected);
      const state = agentRef.current?.exportSessionState?.() || null;
      agentRef.current = new Agent(buildRegistry(workspace.path, mcpToolsRef.current), {
        workspace: workspace.path,
        sessionId: currentSessionRef.current.id,
        model: selected,
        agent: currentSessionRef.current.agent,
        sessionState: { ...state, model: selected },
        autoApprove: autoApproveRef.current,
        partHandler: part => sessionStoreRef.current.updatePart(part.sessionId, part),
      });
      setCurrentModel(selected);
      currentSessionRef.current.model = selected;
      currentSessionRef.current.agentState = agentRef.current.exportSessionState();
      currentSessionRef.current = sessionStoreRef.current.save(currentSessionRef.current);
      const usage = agentRef.current.contextUsage();
      contextUsageRef.current = usage;
      setContextUsage(usage);
      appendArchived({ id: nextId(), type: "answer", content: `Model changed to ${displayModel(selected)}.` });
    };
    if (cmd === "/model" || cmd === "/models") {
      await chooseModel(arg);
      return;
    }
    if (cmd === "/reasoning") {
      if (!String(currentModel).startsWith("codex/")) {
        appendArchived({ id: nextId(), type: "error", content: "Reasoning selection is available only for Codex models." });
        return;
      }
      const effort = arg || await requestValue("Select Codex reasoning effort", ["low", "medium", "high", "xhigh"]);
      if (!effort) return;
      const value = saveReasoningEffort(effort);
      agentRef.current?.setReasoningEffort(value);
      appendArchived({ id: nextId(), type: "answer", content: `Codex reasoning set to ${value}.` });
      return;
    }
    if (cmd === "/usage") {
      const usage = agentRef.current?.contextUsage() || contextUsageRef.current;
      contextUsageRef.current = usage;
      setContextUsage(usage);
      appendArchived({ id: nextId(), type: "answer", content: formatUsageReport(usage) });
      return;
    }
    if (cmd === "/setting") {
      const lowerArg = String(arg || "").trim().toLowerCase();
      if (lowerArg === "show") {

        const { loadModelSettings, resolveEffectiveSettings, formatSettingValue, SETTING_SECTIONS } = await import("../config/model-settings.js");
        const effective = resolveEffectiveSettings(currentModel);
        const lines = [`## Effective Settings for ${currentModel}`, ""];
        for (const [secId, sec] of Object.entries(SETTING_SECTIONS)) {
          lines.push(`**${sec.label}**`);
          for (const setting of sec.settings) {
            const val = effective[setting.key];
            lines.push(`- ${setting.label}: ${formatSettingValue(setting.key, val, currentModel)}`);
          }
          lines.push("");
        }
        appendArchived({ id: nextId(), type: "answer", content: lines.join("\n") });
        return;
      }
      if (lowerArg === "model") {
        setSettingsSection(null);
        setShowSettings(true);
        return;
      }
      if (lowerArg === "reset") {
        setSettingsSection("reset");
        setShowSettings(true);
        return;
      }
      if (lowerArg.startsWith("reset ")) {
        const section = lowerArg.slice(6).trim();
        const validSections = ["generation", "reasoning", "context", "reliability", "tools", "routing"];
        if (validSections.includes(section)) {
          const { resetModelSettings } = await import("../config/model-settings.js");
          resetModelSettings(currentModel, section);
          appendArchived({ id: nextId(), type: "answer", content: `"${section}" settings reset to provider defaults.` });
        } else {
          appendArchived({ id: nextId(), type: "error", content: `Unknown section "${section}". Valid sections: ${validSections.join(", ")}` });
        }
        return;
      }

      setSettingsSection(null);
      setShowSettings(true);
      return;
    }
    if (cmd === "/connect") {
      try {
        const provider = String(arg || await requestValue(
          "Select a provider",
          ["Codex · ChatGPT OAuth", "Custom OpenAI-compatible"],
          { values: [{ label: "Codex · ChatGPT OAuth", value: "codex" }, { label: "Custom OpenAI-compatible", value: "custom" }] },
        )).toLowerCase();
        if (!provider) return;
        if (provider === "codex") {
          await loginCodex({
            onAuthorize: url => appendArchived({
              id: nextId(),
              type: "answer",
              content: `Open this URL to connect Codex:\n${url}`,
            }),
          });
          const models = await listModels("codex");
          if (models.length === 0) throw new Error("Codex did not return any models for this account.");
          saveProvider("codex", { type: "codex-responses", models });
          const selected = await requestValue("Select a Codex model", models, {
            values: models.map(model => ({ label: model, value: model })),
          });
          if (selected) await chooseModel(`codex/${selected}`);
          return;
        }
        if (provider !== "custom") throw new Error(`Unknown provider "${provider}".`);
        const customID = await requestValue("Provider ID");
        if (!customID) return;
        const baseURL = await requestValue("OpenAI-compatible base URL");
        if (!/^https?:\/\//i.test(baseURL)) throw new Error("The provider base URL must use HTTP or HTTPS.");
        const env = `${customID.replace(/[^a-z0-9]/gi, "_").toUpperCase()}_API_KEY`;
        const apiKey = await requestValue("API key", [], { secret: true });
        saveProvider(customID, { type: "openai-compatible", baseURL, env: env || undefined, models: [] });
        if (apiKey) saveProviderCredential(customID, apiKey);
        let models = [];
        try { models = await listModels(customID); } catch {}
        if (models.length === 0) {
          const manual = await requestValue("Model ID");
          if (manual) models = [manual];
        }
        saveProvider(customID, { type: "openai-compatible", baseURL, env: env || undefined, models });
        appendArchived({
          id: nextId(),
          type: "answer",
          content: `Connected provider ${customID}${models.length ? ` with ${models.length} model${models.length === 1 ? "" : "s"}` : ""}.`,
        });
      } catch (error) {
        appendArchived({ id: nextId(), type: "error", content: error.message });
      }
      return;
    }
    if (cmd === "/new") {
      const session = sessionStoreRef.current.create({
        title: arg || "New session",
        model: loadConfig().model,
        agent: loadConfig().defaultAgent || "build",
      });
      loadStoredSession(session);
      return;
    }
    if (cmd === "/sessions") {
      const requested = String(arg || "").trim();
      const [action = "", ...actionArgs] = requested.split(/\s+/);
      const lowerArg = action.toLowerCase();
      if (lowerArg === "clear") {
        if (submittingRef.current) {
          appendArchived({
            id: nextId(),
            type: "error",
            content: "Stop the active run before clearing sessions.",
          });
          return;
        }
        const sessions = sessionStoreRef.current.list();
        if (sessions.length === 0) {
          appendArchived({
            id: nextId(),
            type: "answer",
            content: "No saved sessions found for this folder.",
          });
          return;
        }
        const confirmed = await requestValue(
          "Delete all sessions in this folder?",
          ["Cancel", "Delete all sessions"],
          {
            kind: "mcp",
            values: [
              { label: "Cancel", value: false },
              { label: "Delete all sessions", value: true },
            ],
            archive: false,
            context: `Folder    ${workspace.path}\nSessions  ${sessions.length}\n\nThis action cannot be undone.`,
          },
        );
        if (!confirmed) return;
        const result = removeStoredSessions(sessions.map(s => s.id));
        if (result.failed === 0) {
          appendArchived({
            id: nextId(),
            type: "answer",
            content: `Deleted ${result.deleted} sessions from ${workspace.path}.`,
          });
        } else {
          const removed = sessions.length - result.failed;
          appendArchived({
            id: nextId(),
            type: "error",
            content: `Deleted ${removed} of ${sessions.length} sessions. One session could not be removed.`,
          });
        }
        return;
      }
      const sessions = sessionStoreRef.current.list();
      if (sessions.length === 0) {
        if (lowerArg === "list") {
          appendArchived({ id: nextId(), type: "answer", content: "No saved sessions found for this folder." });
        } else {
          setSessionManagerSessions([]);
        }
        return;
      }
      if (!lowerArg) {
        setSessionManagerSessions(sessions);
        return;
      }
      if (lowerArg === "list") {
        appendArchived({
          id: nextId(),
          type: "answer",
          content: formatSessionList(sessions, currentSessionRef.current.id, workspace.path),
        });
        return;
      }
      const id = actionArgs.join(" ").trim();
      if (lowerArg === "resume") {
        if (!id) {
          appendArchived({ id: nextId(), type: "error", content: "Usage: /sessions resume <session-id>" });
          return;
        }
        try { loadStoredSession(sessionStoreRef.current.load(id)); }
        catch { appendArchived({ id: nextId(), type: "error", content: `Session "${id}" was not found.` }); }
        return;
      }
      if (lowerArg === "delete") {
        if (!id) {
          appendArchived({ id: nextId(), type: "error", content: "Usage: /sessions delete <session-id>" });
          return;
        }
        const target = sessions.find(session => session.id === id);
        if (!target) {
          appendArchived({ id: nextId(), type: "error", content: `Session "${id}" was not found.` });
          return;
        }
        const confirmed = await requestValue(
          `Remove session \`${target.title || target.id}\`?`,
          ["Cancel", "Remove"],
          {
            archive: false,
            kind: "mcp",
            values: [
              { label: "Cancel", value: false },
              { label: "Remove", value: true },
            ],
          },
        );
        if (!confirmed) return;
        const result = removeStoredSessions([id]);
        appendArchived({
          id: nextId(),
          type: result.failed ? "error" : "answer",
          content: result.failed ? `Session "${id}" could not be removed.` : `Session "${id}" was removed.`,
        });
        return;
      }
      appendArchived({
        id: nextId(),
        type: "error",
        content: `Unknown sessions action "${action}". Use list, resume, delete, or clear.`,
      });
      return;
    }
    if (cmd === "/continue") {
      const sessions = sessionStoreRef.current.list();
      if (sessions.length === 0) {
        appendArchived({ id: nextId(), type: "answer", content: "No saved sessions for this folder." });
        return;
      }
      const values = sessions.map(session => ({
        label: `${session.title} · ${session.model} · ${session.id.slice(0, 8)}`,
        value: session.id,
      }));
      const id = arg || await requestValue("Select a session", values.map(entry => entry.label), { values });
      if (!id) return;
      try { loadStoredSession(sessionStoreRef.current.load(id)); }
      catch { appendArchived({ id: nextId(), type: "error", content: `Session "${id}" was not found.` }); }
      return;
    }
    if (cmd === "/fork") {
      loadStoredSession(sessionStoreRef.current.fork(currentSessionRef.current.id));
      appendArchived({ id: nextId(), type: "answer", content: "Session forked." });
      return;
    }
    if (cmd === "/undo" || cmd === "/redo") {
      try {
        const result = cmd === "/undo"
          ? sessionStoreRef.current.undo(currentSessionRef.current)
          : sessionStoreRef.current.redo(currentSessionRef.current);
        loadStoredSession(result.session);
        if (result.warning) appendArchived({ id: nextId(), type: "answer", content: result.warning });
      } catch (error) {
        appendArchived({ id: nextId(), type: "error", content: error.message });
      }
      return;
    }
    if (cmd === "/compact") {
      const startedAt = Date.now();
      const before = agentRef.current.contextUsage();
      contextUsageRef.current = {
        ...before,
        compactionStatus: "summarizing",
        compactionStartedAt: startedAt,
      };
      setContextUsage(contextUsageRef.current);
      await Promise.resolve();
      currentSessionRef.current.agentState = agentRef.current.compact();
      currentSessionRef.current = sessionStoreRef.current.save(currentSessionRef.current);
      const after = agentRef.current.contextUsage();
      contextUsageRef.current = {
        ...after,
        compactionStatus: "completed",
        compactionStartedAt: null,
      };
      setContextUsage(contextUsageRef.current);
      return;
    }
    if (cmd === "/export") {
      const path = resolve(workspace.path, arg || `khazai-session-${currentSessionRef.current.id.slice(0, 8)}.md`);
      sessionStoreRef.current.exportMarkdown(currentSessionRef.current, path);
      appendArchived({ id: nextId(), type: "answer", content: `Session exported to ${path}.` });
      return;
    }
    if (cmd === "/details") {
      const detailArg = String(arg || "").trim().toLowerCase();
      const latest = completedRef.current.findLast(message => message.type === "tool");
      if (detailArg === "on" || detailArg === "expand") {
        setExpandedTool(latest ? { ...latest, id: `expanded-${latest.id}`, expanded: true } : null);
      } else if (detailArg === "off" || detailArg === "collapse") {
        setExpandedTool(null);
      } else {
        setExpandedTool(current => current ? null : latest ? { ...latest, id: `expanded-${latest.id}`, expanded: true } : null);
      }
      return;
    }
    if (cmd === "/agent") {
      const profiles = [...loadAgentProfiles(workspace.path).values()].filter(profile => profile.role === "primary");
      const values = profiles.map(profile => ({
        label: `${profile.name} · ${profile.description}`,
        value: profile.name,
      }));
      const selected = arg || await requestValue("Select an agent", values.map(entry => entry.label), { values });
      const profile = profiles.find(item => item.name === selected);
      if (!profile) {
        appendArchived({ id: nextId(), type: "error", content: `Agent "${selected}" was not found.` });
        return;
      }
      const state = agentRef.current.exportSessionState();
      agentRef.current = new Agent(buildRegistry(workspace.path, mcpToolsRef.current), {
        workspace: workspace.path,
        sessionId: currentSessionRef.current.id,
        model: currentModel,
        agent: selected,
        sessionState: { ...state, agent: selected },
        autoApprove: autoApproveRef.current,
        partHandler: part => sessionStoreRef.current.updatePart(part.sessionId, part),
      });
      currentSessionRef.current.agent = selected;
      currentSessionRef.current.agentState = agentRef.current.exportSessionState();
      currentSessionRef.current = sessionStoreRef.current.save(currentSessionRef.current);
      planWorkflowRef.current = null;
      planningQuestionRef.current = null;
      buildStartedPlanIdRef.current = null;
      setModeStatus(selected === "plan"
        ? { mode: "plan", status: "reviewing" }
        : null);
      appendArchived({ id: nextId(), type: "answer", content: `Agent changed to ${selected}.` });
      return;
    }
    if (cmd === "/skills") {
      const permissions = new PermissionService(workspace.path);
      const skills = listSkills(workspace.path).filter(skill =>
        permissions.evaluate("skill", { name: skill.name }).decision !== "deny"
      );
      const content = skills.length
        ? [
            "Discovered skills:",
            ...skills.map(skill =>
              `- ${skill.name} — ${skill.description} (${skill.scope}:${skill.namespace})`
            ),
          ].join("\n")
        : "No valid skills were discovered.";
      appendArchived({ id: nextId(), type: "answer", content });
      return;
    }
    if (cmd === "/lsp") {
      const status = lspStatus(workspace.path);
      const content = !status.enabled
        ? "LSP is disabled. Set `lsp` to `true` or configure servers in khazai-ai config."
        : [
            "Language servers:",
            ...status.servers.map(server =>
              `- ${server.id}: ${server.state}${server.pid ? ` (PID ${server.pid})` : ""} — ${server.extensions.join(", ")}`
            ),
          ].join("\n");
      appendArchived({ id: nextId(), type: "answer", content });
      return;
    }
    if (cmd === "/mcp") {
      if (!mcpManager) {
        appendArchived({ id: nextId(), type: "answer", content: "No MCP manager is available." });
        return;
      }
      const syncTools = async tools => {
        const state = agentRef.current?.exportSessionState?.() || null;
        mcpToolsRef.current = tools;
        const registry = buildRegistry(workspace.path, mcpToolsRef.current);
        if (submittingRef.current && agentRef.current) {
          await agentRef.current.replaceRegistry(registry);
          return;
        }
        agentRef.current = new Agent(registry, {
          workspace: workspace.path,
          sessionId: currentSessionRef.current.id,
          model: currentModel,
          agent: currentSessionRef.current.agent,
          sessionState: state,
          autoApprove: autoApproveRef.current,
          partHandler: part => sessionStoreRef.current.updatePart(part.sessionId, part),
        });
      };
      await manageMcpCommand(arg, {
        manager: mcpManager,
        requestValue: (question, options, settings) =>
          requestValue(question, options, { ...settings, archive: false }),
        syncTools,
        respond: (type, content) => appendArchived({ id: nextId(), type, content }),
      });
      return;
    }
    if (cmd === "/theme" && arg) {
      try {
        const selected = await saveTheme(arg);
        setThemeName(selected);
        themePreviewRef.current = null;
        appendArchived({ id: nextId(), type: "answer", content: `Theme saved: **${selected}**.` });
      } catch (error) {
        appendArchived({ id: nextId(), type: "error", content: error.message });
      }
      return;
    }
    if (cmd === "/help") {
      appendArchived({ id: nextId(), type: "answer", content: `# Commands\n\n${formatCommandHelp()}` });
    }
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
    showInitPrompt,
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

  const submit = useCallback(async (input, options = {}) => {
    const retryProvider = Boolean(options.retryProvider);
    const approvedPlan = options.approvedPlan || null;
    const internalInput = Boolean(options.internalInput);
    const queuedItemId = options.queuedItemId || null;
    const initTask = options.initTask || null;
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
    let finishedNormally = false;
    let finalCommitted = false;
    let fatalError = "";
    let recoverableFailure = false;
    let queueHandoffPending = false;
    let handedOffForQueue = false;
    let finalResponse = "";
    let latestPlan = [];
    let finalizedPlanningState = null;
    const sessionBefore = currentSessionRef.current;
    const runId = nextId();
    const turnId = options.turnId || `${sessionBefore?.id || "session"}-${runId}`;
    if (!retryProvider) taskEpochRef.current++;
    const analysisScope = {
      runId,
      turnId,
      taskEpoch: taskEpochRef.current,
      ...(approvedPlan?.planId ? { planId: approvedPlan.planId } : {}),
    };
    const planningRun = currentSessionRef.current.agent === "plan" && !approvedPlan;
    const previousPlan = planWorkflowRef.current;
    let planningState = planningRun
      ? previousPlan?.mode === "plan" && ["reviewing", "investigating", "questioning"].includes(previousPlan.status)
        ? { ...previousPlan, ...analysisScope, status: "investigating" }
        : createPlanModeState({ objective: input, ...analysisScope })
      : null;
    if (planningRun) {
      planWorkflowRef.current = planningState;
      setModeStatus({ mode: "plan", status: "investigating" });
    } else if (approvedPlan) {
      setModeStatus({ mode: "build", status: "preparing" });
    }
    activeScopeRef.current = analysisScope;
    cancelledRunIdRef.current = null;
    analysisRef.current = createAnalysisActivity({
      ...analysisScope,
      analysisId: `analysis-${turnId}`,
    });
    responseBufferRef.current = createResponseBuffer(analysisScope);
    let initEvidence = null;
    let initPhase = "inspecting";
    const initResponse = { content: "" };
    const setInitPhase = status => {
      if (initPhase !== status) {
        initPhase = status;
        setModeStatus({ mode: "init", status });
      }
    };
    if (initTask) {
      initEvidence = initTask.previousEvidence
        || (initTask.baseline ? { ...initTask.baseline } : null)
        || collectInitEvidence(workspace.path);
      setInitPhase("inspecting");
    }
    const openInitPrompt = state => {
      initStateRef.current = state;
      setInitState(state);
      setShowInitPrompt(true);
    };
    const gitBefore = sessionStoreRef.current.captureGitState();
    const agentStateBefore = agentRef.current?.exportSessionState?.() || null;
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
        thinkActivityFromPlan(planRef.current),
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
      const filePath = args?.path ? resolve(workspace.path, String(args.path)) : null;
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
    const completeStreaming = () => {
      const committed = commitResponseBuffer(responseBufferRef.current, analysisScope);
      responseBufferRef.current = committed.state;
      if (!committed.response) return "";
      const content = normalizeStreamText(agent.redactForDisplay(committed.response.content));
      if (!content) return "";
      if (initTask) {
        initResponse.content = content;
        setInitPhase("preparing");
        finalCommitted = true;
        return content;
      }
      appendArchived({ id: committed.response.id, type: "answer", content });
      finalCommitted = true;
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

    const previousAgent = agentRef.current;
    let agent = agentRef.current;
    if (initTask) {
      agent = new Agent(
        buildRegistry(workspace.path, mcpToolsRef.current).subset(INIT_TOOLS),
        {
          workspace: workspace.path,
          sessionId: randomUUID(),
          model: currentModel,
          agent: "build",
          autoApprove: false,
          readOnly: true,
        },
      );
      agentRef.current = agent;
    }
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
      };
    }));
    try {
    updateUsage();
    const agentInput = initTask
      ? input
      : retryProvider
      ? ""
      : input.trimStart().startsWith("!")
      ? input
      : attachFileReferences(input, workspace.path);
    for await (const ev of agent.loop(agentInput, undefined, {
      ...analysisScope,
      retryProvider,
      approvedPlan,
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
      if (queueHandoffPending) {
        if (messageQueueRef.current.pendingCount() > 0) {
          handedOffForQueue = true;
          cancelledRunIdRef.current = analysisScope.runId;
          responseBufferRef.current = discardResponseBuffer(responseBufferRef.current, analysisScope);
          setPlan([]);
          agent.abort();
          break;
        }
        queueHandoffPending = false;
      }
      if (cancelledRunIdRef.current === analysisScope.runId) continue;
      if (!analysisEventIsCurrent(ev, analysisScope)) continue;
      if (ev.type === "thinking") {
        if (initTask) {
          if (initPhase === "reviewing") setInitPhase("generating");
          resetStreaming();
          continue;
        }
        if (planningRun) setModeStatus({ mode: "plan", status: "investigating" });
        resetStreaming();
        finishReadBatch();
        showAnalysis(thinkActivityFromPlan(planRef.current, ev.phase));
        continue;
      }

      if (ev.type === "public-activity") {
        if (initTask) continue;
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
        latestPlan = ev.items.map(item => ({ ...item, status: item.status || "pending" }));
        setPlan(latestPlan);
        continue;
      }

      if (ev.type === "plan-update") {
        setPlan(prev => {
          const next = prev.map((item, i) =>
            i === ev.index ? { ...item, status: ev.status } : item
          );
          if (activeRef.current?.type === "think") {
            updateAnalysis(thinkActivityFromPlan(next));
          }
          return next;
        });
        continue;
      }

      if (ev.type === "question") {
        resetStreaming();
        finishReadBatch();
        pauseAnalysis();
        if (planningRun) setModeStatus({ mode: "plan", status: "questioning" });
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
        setPendingQuestion({
          id: `permission-${ev.callId}`,
          question: ev.action,
          options: ev.options,
          kind: "permission",
          permissionRequest: {
            action: agent.redactForDisplay(ev.action),
            target: agent.redactSerializableForDisplay(ev.target),
          },
          runId: ev.runId,
          turnId: ev.turnId,
        });
        continue;
      }

      if (ev.type === "tool-part") {
        const part = ev.part;
        if (!part || part.type !== "tool") continue;
        if (part.tool === "question") continue;
        structuredCallsRef.current.add(part.callId);
        if (part.tool === "think") {
          if (initTask) continue;
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
        if (initTask) {
          if (initPhase === "inspecting") setInitPhase("reviewing");
          if (ev.tool === "read" && ev.args?.path) {
            initEvidence.inspectedFiles.push(String(ev.args.path));
          }
          if (ev.tool === "bash" && ev.args?.command) {
            initEvidence.commands.push(String(ev.args.command).slice(0, 200));
          }
          if (ev.tool === "glob" && ev.args?.pattern) {
            initEvidence.patterns.push(String(ev.args.pattern));
          }
        }
        resetStreaming();
        if (ev.tool === "think") {
          if (initTask) {
            finishReadBatch();
            continue;
          }
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
        continue;
      }

      if (ev.type === "stream-discard") {
        resetStreaming();
        continue;
      }

      if (ev.type === "stream-commit") {
        finishReadBatch();
        resetStreaming();
        continue;
      }

      if (ev.type === "tool-result") {
        updateUsage();
        if (ev.tool === "think") {
          if (!initTask && messageQueueRef.current.pendingCount() > 0) queueHandoffPending = true;
          continue;
        }
        if (!initTask && messageQueueRef.current.pendingCount() > 0) queueHandoffPending = true;
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
          if (queueHandoffPending) finishReadBatch();
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
        const safeContent = removeAssistantProtocolText(agent.redactForDisplay(removeEmoji(ev.content))).trim();
        const thinkTimeout = ev.type === "error" && /Analysis timed out|timed out/i.test(safeContent);
        if (ev.type === "answer") {
          pauseAnalysis();
          finishedNormally = true;
          finalResponse = safeContent;
          if (!planningRun) setPlan([]);
        } else if (ev.recoverable) {
          recoverableFailure = true;
          pauseAnalysis();
          clearActive();
          analysisRef.current = clearAnalysisActivity(analysisRef.current, analysisScope);
        } else if (thinkTimeout) {
          fatalError = "Analysis timed out";
          pauseAnalysis();
          analysisRef.current = failAnalysisActivity(analysisRef.current, analysisScope);
          const timeoutMessage = analysisActivityMessage(analysisRef.current);
          if (timeoutMessage) appendArchived(timeoutMessage);
          analysisRef.current = clearAnalysisActivity(analysisRef.current, analysisScope);
        } else {
          fatalError = safeContent || "The provider failed";
          clearActive();
          analysisRef.current = clearAnalysisActivity(analysisRef.current, analysisScope);
        }
        if (safeContent && !thinkTimeout) {
          if (initTask) {
            initResponse.content = safeContent;
            setInitPhase("preparing");
            finalCommitted = true;
            if (ev.type === "answer") finishedNormally = true;
          } else {
            appendArchived({
              id: nextId(),
              type: ev.recoverable ? "provider-error" : ev.type,
              content: safeContent,
            });
            if (ev.type === "answer") finalCommitted = true;
          }
        }
        continue;
      }

      if (ev.type === "stream-end") {
        finishReadBatch();
        pauseAnalysis();
        finalResponse = completeStreaming() || finalResponse;
        if (!planningRun) setPlan([]);
        finishedNormally = true;
        updateUsage();
        continue;
      }
    }
    if (queueHandoffPending && messageQueueRef.current.pendingCount() > 0) {
      handedOffForQueue = true;
      cancelledRunIdRef.current = analysisScope.runId;
      agent.abort();
    }
    } catch (error) {
      discardStreaming();
      finishReadBatch();
      pauseAnalysis();
      analysisRef.current = clearAnalysisActivity(analysisRef.current, analysisScope);
      clearActive();
      const content = removeAssistantProtocolText(agent.redactForDisplay(error?.message || String(error))).trim();
      if (content) {
        fatalError = `Unexpected error: ${content}`;
        appendArchived({ id: nextId(), type: "error", content: fatalError });
      }
    } finally {
      updateUsage();
      agentSessionRef.current = initTask
        ? (previousAgent?.exportSessionState?.() || null)
        : (agent.exportSessionState?.() || null);
      if (
        planningRun
        && finishedNormally
        && finalCommitted
        && cancelledRunIdRef.current !== runId
      ) {
        if (planWorkflowRef.current?.planId === planningState?.planId) {
          planningState = planWorkflowRef.current;
        }
        const context = agent.planningContext();
        finalizedPlanningState = finalizePlanMode(planningState, {
          workspace: workspace.path,
          summary: finalResponse,
          relevantFiles: context.relevantFiles,
          steps: latestPlan.length ? latestPlan : context.plan,
        });
        planWorkflowRef.current = finalizedPlanningState;
        planningState = finalizedPlanningState;
        setModeStatus({ mode: "plan", status: "reviewing" });
      }
      discardStreaming();
      finishReadBatch();
      clearActive();
      if (finishedNormally && analysisRef.current) {
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
      if (initTask) {
        agentRef.current = previousAgent;
        setModeStatus(null);
        const initCancelled = cancelledRunIdRef.current === runId;
        if (initCancelled) {
          initStateRef.current = null;
          setInitState(null);
          initRegenerateRef.current = null;
        } else if (!initResponse.content) {
          const initGenerationId = initTask.generationId || ++initGenerationRef.current;
          const failedState = errorText => openInitPrompt({
            mode: "failed",
            workspaceRoot: initEvidence?.workspaceRoot || workspace.path,
            inspectedCount: initEvidence?.inspectedFiles?.length || 0,
            sectionCount: 0,
            wordCount: 0,
            previewContent: initResponse.content,
            proposedContent: "",
            existingPath: null,
            warnings: [],
            error: errorText,
            generationId: initGenerationId,
            evidence: initEvidence,
          });
          if (!initResponse.content) {
            failedState(fatalError || "The model returned no content.");
          } else {
            const prepared = prepareInitPreview({ content: initResponse.content, evidence: initEvidence });
            if (!prepared.ok) {
              failedState(prepared.error);
            } else if (initTask.kind === "preview") {
              appendArchived({
                id: nextId(),
                type: "answer",
                content: `# AGENTS.md Preview\n\n${prepared.markdown}`,
              });
              if (prepared.warnings.length) {
                appendArchived({
                  id: nextId(),
                  type: "answer",
                  content: prepared.warnings.map(warning => `! ${warning}`).join("\n"),
                });
              }
            } else {
              const existing = prepared.existing;
              const mode = existing
                ? (initTask.kind === "force" ? "replaceConfirm" : "update")
                : "create";
              let proposedContent = prepared.markdown;
              let mergedExisting = false;
              if (mode === "update") {
                const merged = mergeExistingContent(existing, prepared.markdown);
                if (merged === existing) {
                  mergedExisting = true;
                } else {
                  proposedContent = merged;
                }
              }
              if (mergedExisting) {
                appendArchived({
                  id: nextId(),
                  type: "answer",
                  content: "AGENTS.md is already up to date.",
                });
              } else {
                openInitPrompt({
                  mode,
                  workspaceRoot: prepared.workspaceRoot,
                  inspectedCount: [...new Set(initEvidence?.inspectedFiles || [])].length,
                  sectionCount: prepared.sectionCount,
                  wordCount: prepared.wordCount,
                  previewContent: prepared.markdown,
                  proposedContent,
                  existingContent: existing || undefined,
                  existingPath: prepared.existingPath,
                  warnings: prepared.warnings,
                  generationId: initGenerationId,
                  evidence: initEvidence,
                });
              }
            }
          }
        }
      }
      const runResult = recoverableFailure || handedOffForQueue ? null : terminalRunResult({
        cancelled: cancelledRunIdRef.current === runId,
        completionGaps: agent._executionPolicy?.completionGaps?.() || [],
        fatalError,
        finalCommitted,
        finishedNormally,
      });
      if (!initTask && runResult?.status === "failed" && runResult.unresolvedIssues.length) {
        appendArchived({
          id: nextId(),
          type: "summary",
          status: "attention",
          unresolvedIssues: runResult.unresolvedIssues,
        });
      }
      const session = currentSessionRef.current;
      if (!initTask && session?.id === sessionBefore?.id) {
        if (retryProvider) {
          currentSessionRef.current = sessionStoreRef.current.save({
            ...session,
            messages: completedRef.current,
            agentState: agentSessionRef.current,
            savedPlan: latestPlan.map(item => ({ ...item })),
          });
        } else {
          if (session.turns.length === 0) session.title = redactSecrets(input).slice(0, 72);
          session.savedPlan = latestPlan.map(item => ({ ...item }));
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
      if (!recoverableFailure) agent.clearTurnSecrets(analysisScope);
      if (queuedItemId) {
        const cancelled = cancelledRunIdRef.current === runId && !handedOffForQueue;
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
      } else if (finalizedPlanningState) {
        queueMicrotask(() => openPlanApprovalRef.current?.(finalizedPlanningState));
      } else if (approvedPlan) {
        planWorkflowRef.current = null;
        buildStartedPlanIdRef.current = null;
        setModeStatus(null);
      }
    }
  }, [appendArchived]);
  submitRef.current = submit;

  const handlePromptSubmit = useCallback((input, options) => {
    const pendingRegenerate = initRegenerateRef.current;
    if (pendingRegenerate && initAwaitingInstructionRef.current) {
      initAwaitingInstructionRef.current = false;
      initRegenerateRef.current = null;
      const generationId = ++initGenerationRef.current;
      return submitRef.current?.(buildInitTaskPrompt({
        previousEvidence: pendingRegenerate.evidence,
        previousMarkdown: pendingRegenerate.markdown,
        customInstruction: input,
      }), {
        internalInput: true,
        initTask: {
          kind: pendingRegenerate.mode === "update" || pendingRegenerate.mode === "replaceConfirm"
            ? "update"
            : "default",
          previousEvidence: pendingRegenerate.evidence,
          previousMarkdown: pendingRegenerate.markdown,
          customInstruction: input,
          generationId,
        },
      });
    }
    return submit(input, options);
  }, [submit]);

  const replaceAgentProfile = useCallback((name, state = null) => {
    const previous = state || agentRef.current?.exportSessionState?.() || null;
    agentRef.current?.abort();
    agentRef.current = new Agent(buildRegistry(workspace.path, mcpToolsRef.current), {
      workspace: workspace.path,
      sessionId: currentSessionRef.current.id,
      model: currentModel,
      agent: name,
      sessionState: previous ? { ...previous, agent: name } : null,
      autoApprove: autoApproveRef.current,
      partHandler: part => sessionStoreRef.current.updatePart(part.sessionId, part),
    });
    currentSessionRef.current.agent = name;
    currentSessionRef.current.agentState = agentRef.current.exportSessionState();
    currentSessionRef.current = sessionStoreRef.current.save(currentSessionRef.current);
  }, [currentModel, workspace.path]);

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
    setPlan(plan.steps.map(description => ({ description, status: "pending" })));
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
        runId: plan.runId,
        turnId: plan.turnId,
        taskEpoch: plan.taskEpoch,
      }),
    };
    setPendingQuestion({ kind: "plan", question, context, options });
  }, []);

  openPlanApprovalRef.current = plan => openPlanSelection(
    "plan-approval",
    "Ready to continue",
    "Choose what KhazAI should do with this implementation plan.",
    PLAN_ACTIONS,
    plan,
  );

  planActionRef.current = (kind, answer, expected) => {
    const plan = planWorkflowRef.current;
    const action = typeof answer === "string" ? answer : answer?.id || answer?.label;
    if (
      !plan
      || plan.planId !== expected?.planId
      || plan.runId !== expected?.runId
      || plan.turnId !== expected?.turnId
      || plan.taskEpoch !== expected?.taskEpoch
    ) return;
    if (kind === "plan-revalidation") {
      if (action === "revalidate") {
        const refreshed = refreshPlanSnapshots(plan, workspace.path);
        planWorkflowRef.current = refreshed;
        launchApprovedPlan(refreshed);
      } else if (action === "plan") {
        buildStartedPlanIdRef.current = null;
        planWorkflowRef.current = { ...plan, mode: "plan", status: "reviewing", approvedAt: null };
        replaceAgentProfile("plan");
        setModeStatus({ mode: "plan", status: "reviewing" });
      } else {
        planWorkflowRef.current = null;
        buildStartedPlanIdRef.current = null;
        replaceAgentProfile("build");
        setPlan([]);
        setModeStatus(null);
      }
      return;
    }
    if (plan.status !== "reviewing") return;
    if (action === "implement") {
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
    if (action === "revise" || action === "question") {
      setModeStatus({
        mode: "plan",
        status: action === "question" ? "questioning" : "reviewing",
      });
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
      setModeStatus({ mode: "plan", status: "investigating" });
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
    if (pending.kind === "plan-approval" || pending.kind === "plan-revalidation") {
      const plan = planWorkflowRef.current;
      planActionRef.current?.(pending.kind, { id: "cancel", label: "Cancel" }, plan && {
        planId: plan.planId,
        runId: plan.runId,
        turnId: plan.turnId,
        taskEpoch: plan.taskEpoch,
      });
      return;
    }
    if (pending.kind === "plan-decision") {
      planningQuestionRef.current = null;
      setModeStatus({ mode: "plan", status: "investigating" });
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
    responseBufferRef.current = interruption.responseBuffer;
    analysisRef.current = null;
    setPendingQuestion(null);
    setPlan([]);
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
  const visiblePlan = plan;
  const displayedActiveMessage = activeMessage;

  const handleCloseSettings = useCallback(() => {
    setShowSettings(false);
    setSettingsSection(null);
  }, []);

  const handleInitWrite = useCallback(() => {
    const state = initStateRef.current;
    if (!state || state.mode === "failed" || submittingRef.current) return;
    setShowInitPrompt(false);
    try {
      const content = state.proposedContent;
      if (state.generator) state.generator.writeAtomic(content, state.existingPath);
      else writeAtomicFile(content, state.existingPath);
      appendArchived({
        id: nextId(),
        type: "answer",
        content: `AGENTS.md generated at \`${state.existingPath}\``,
      });
    } catch (error) {
      appendArchived({
        id: nextId(),
        type: "error",
        content: `AGENTS.md could not be generated.`,
      });
    }
    initStateRef.current = null;
    setInitState(null);
  }, [appendArchived]);

  const handleInitUpdate = useCallback(() => {
    const state = initStateRef.current;
    if (!state || state.mode === "failed" || submittingRef.current) return;
    setShowInitPrompt(false);
    try {
      const content = state.proposedContent;
      if (state.generator) state.generator.writeAtomic(content, state.existingPath);
      else writeAtomicFile(content, state.existingPath);
      appendArchived({
        id: nextId(),
        type: "answer",
        content: `AGENTS.md updated at \`${state.existingPath}\``,
      });
    } catch (error) {
      appendArchived({
        id: nextId(),
        type: "error",
        content: `AGENTS.md could not be updated.`,
      });
    }
    initStateRef.current = null;
    setInitState(null);
  }, [appendArchived]);

  const handleInitReplace = useCallback(() => {
    const state = initStateRef.current;
    if (!state || state.mode === "failed" || submittingRef.current) return;
    setShowInitPrompt(false);
    try {
      const content = state.previewContent;
      if (state.generator) state.generator.writeAtomic(content, state.existingPath);
      else writeAtomicFile(content, state.existingPath);
      appendArchived({
        id: nextId(),
        type: "answer",
        content: `AGENTS.md replaced at \`${state.existingPath}\``,
      });
    } catch (error) {
      appendArchived({
        id: nextId(),
        type: "error",
        content: `AGENTS.md could not be replaced.`,
      });
    }
    initStateRef.current = null;
    setInitState(null);
  }, [appendArchived]);

  const handleInitRegenerate = useCallback(() => {
    const state = initStateRef.current;
    if (!state || submittingRef.current) return;
    setShowInitPrompt(false);
    const generationId = ++initGenerationRef.current;
    const previousEvidence = state.evidence || null;
    const previousMarkdown = state.previewContent || null;
    submitRef.current?.(buildInitTaskPrompt({
      previousEvidence,
      previousMarkdown,
    }), {
      internalInput: true,
      initTask: {
        kind: state.mode === "update" || state.mode === "replaceConfirm" ? "update" : "default",
        previousEvidence,
        previousMarkdown,
        generationId,
      },
    });
  }, []);

  const handleInitCustomInstruction = useCallback(() => {
    const state = initStateRef.current;
    if (!state || state.mode === "failed" || submittingRef.current) return;
    initRegenerateRef.current = {
      evidence: state.evidence || null,
      markdown: state.previewContent || null,
      mode: state.mode,
    };
    setShowInitPrompt(false);
    initStateRef.current = null;
    setInitState(null);
    initAwaitingInstructionRef.current = true;
    appendArchived({
      id: nextId(),
      type: "answer",
      content: "Type your custom instruction and press Enter to regenerate AGENTS.md.",
    });
  }, [appendArchived]);

  const handleInitBasic = useCallback(() => {
    const state = initStateRef.current;
    if (!state) return;
    setShowInitPrompt(false);
    initStateRef.current = null;
    setInitState(null);
    runBasicInit();
  }, [runBasicInit]);

  const handleInitChangeModel = useCallback(() => {
    const state = initStateRef.current;
    if (!state) return;
    setShowInitPrompt(false);
    initStateRef.current = null;
    setInitState(null);
    handleCommandRef.current?.("/model", "");
  }, []);

  const handleInitCancel = useCallback(() => {
    setShowInitPrompt(false);
    initStateRef.current = null;
    setInitState(null);
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

  return h(ThemeProvider, { name: themeName }, h(Box, { flexDirection: "column", width: "100%" },
    h(Static, {
      key: `history-${sessionKey}`,
      items: staticItems,
    }, item => item.type === "banner"
      ? h(Banner, {
          key: item.id,
          model: currentModel,
          workspace: workspace.path,
          agent: currentSessionRef.current.agent,
          autoApprove: autoApproveRef.current,
        })
      : h(MessageList, { key: item.id, messages: [item] })),
    h(Box, { flexDirection: "column", width: "100%" },
      displayedActiveMessage
        ? h(MessageList, {
            key: displayedActiveMessage.id,
            messages: [displayedActiveMessage],
          })
        : null,
      expandedTool && !running
        ? h(MessageList, { messages: [expandedTool] })
        : null,
      completedMessages.length === 0 && !activeMessage && !pendingQuestion && plan.length === 0
        ? h(EmptyState)
        : null,
      h(PlanList, { plan: visiblePlan }),
      sessionManagerSessions !== null
        ? h(SessionManager, {
            key: "session-manager",
            workspacePath: workspace.path,
            sessions: sessionManagerSessions,
            currentSessionId: currentSessionRef.current.id,
            onResume: handleResumeSession,
            onDelete: handleDeleteSession,
            onClear: handleClearSessions,
            onClose: () => setSessionManagerSessions(null),
          })
        : null,
      showInitPrompt && initState
        ? h(InitPrompt, {
            mode: initState.mode,
            workspaceRoot: initState.workspaceRoot,
            sectionCount: initState.sectionCount,
            inspectedCount: initState.inspectedCount,
            wordCount: initState.wordCount,
            previewContent: initState.previewContent,
            proposedContent: initState.proposedContent,
            existingContent: initState.existingContent,
            warnings: initState.warnings,
            error: initState.error,
            onWrite: handleInitWrite,
            onUpdate: handleInitUpdate,
            onReplace: handleInitReplace,
            onRegenerate: handleInitRegenerate,
            onCustomInstruction: handleInitCustomInstruction,
            onBasic: handleInitBasic,
            onChangeModel: handleInitChangeModel,
            onCancel: handleInitCancel,
          })
        : showSettings
          ? h(SettingsMenu, {
              model: currentModel,
              initialSection: settingsSection === "reset" ? "reset" : settingsSection,
              onClose: handleCloseSettings,
              onSettingChange: handleSettingChange,
            })
          : h(SessionFooter, {
            key: "session-footer",
            running,
            waitingForAnswer: Boolean(pendingQuestion),
            queueCount: queuedCount,
            model: displayModel(currentModel),
            modeStatus,
            contextUsage,
            hasSpecificActivity: Boolean(
              displayedActiveMessage && displayedActiveMessage.type !== "streaming"
            ),
            activityScope: activeScopeRef.current,
            promptProps: {
              onSubmit: pendingQuestion ? answerQuestion : handlePromptSubmit,
              onCommand: handleCommand,
              onClear: clearDisplay,
              onAbort: handleAbort,
              commands: COMMANDS,
              inputActive: !messageQueueRef.current.exiting
                && sessionManagerSessions === null
                && !showInitPrompt,
              canAbort: running && !pendingQuestion,
              activeModel: currentModel,
              questionOptions: pendingQuestion?.options || [],
              question: pendingQuestion?.question || "",
              questionContext: pendingQuestion?.context || "",
              questionKind: pendingQuestion?.kind || "",
              permissionRequest: pendingQuestion?.permissionRequest || null,
              onSelectOption: answerQuestion,
              onCancelOption: cancelQuestion,
              secret: Boolean(pendingQuestion?.secret),
              fileItems: workspaceFiles,
              onPreviewChange: handleThemePreview,
              onExitSub: handleThemeExitSub,
            },
          }),
    ),
  ));
}
