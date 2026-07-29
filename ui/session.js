import { createElement as h } from "react";
import { useState, useRef, useCallback } from "react";
import { Box, Static } from "ink";
import { resolve } from "node:path";
import { Agent } from "../app/agent.js";
import { PermissionService } from "../app/permission.js";
import { Registry } from "../app/registry.js";
import { SessionStore } from "../app/session-store.js";
import { builtinTools } from "../app/builtin-tools.js";
import { loadAgentProfiles } from "../app/agent-profiles.js";
import { listSkills } from "../app/skills.js";
import { lspStatus } from "../app/lsp.js";
import { configuredModels, loadConfig, saveModel, saveProvider, saveReasoningEffort, saveSyntaxTheme, saveTheme } from "../config/index.js";
import { removeCredential, saveCredential, saveProviderCredential } from "../lib/auth.js";
import { loginCodex } from "../lib/codex-auth.js";
import { listModels } from "../lib/llm.js";
import { COMMANDS, formatCommandHelp } from "./commands.js";
import { Banner } from "./components/banner.js";
import { MessageList } from "./components/message-list.js";
import { PlanList } from "./components/plan-list.js";
import { SessionFooter } from "./components/session-footer.js";
import { EmptyState } from "./components/empty-state.js";
import { normalizeVerticalWhitespace } from "./text-layout.js";
import { classifyToolState } from "./tool-presentation.js";
import { removeAssistantProtocolText, removeEmoji } from "../lib/assistant-text.js";
import { redactSecrets } from "../lib/secrets.js";
import { ThemeProvider } from "./theme.js";
import { SYNTAX_THEMES } from "./syntax-theme.js";
import { attachFileReferences, listWorkspaceFiles } from "./file-reference.js";
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
  options.filter(Boolean).forEach((option, index) => lines.push(`${index + 1}. ${removeEmoji(option)}`));
  return lines.filter(Boolean).join("\n");
}

export function Session({ workspace, mcpManager = null, initialMcpTools = [] }) {
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
  const [runningStartedAt, setRunningStartedAt] = useState(null);
  const [currentModel, setCurrentModel] = useState(currentSessionRef.current.model);
  const [themeName, setThemeName] = useState(initialConfig.current.theme || "system");
  const [syntaxThemeName, setSyntaxThemeName] = useState(initialConfig.current.syntaxTheme || "catppuccin-mocha");
  const [workspaceFiles, setWorkspaceFiles] = useState(() => listWorkspaceFiles(workspace.path));
  const [sessionKey, setSessionKey] = useState(0);
  const [pendingQuestion, setPendingQuestion] = useState(null);
  const [expandedTool, setExpandedTool] = useState(null);
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
      resolve: answer => resolveValue(values.get(answer) ?? answer),
      scope: null,
    };
    setPendingQuestion({
      question,
      options,
      secret: Boolean(settings.secret),
      kind: settings.kind || "command",
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
    setCompletedMessages(session.messages || []);
    setActiveMessage(null);
    setPlan([]);
    setExpandedTool(null);
    setCurrentModel(session.model);
    structuredCallsRef.current.clear();
    setSessionKey(key => key + 1);
  }, [workspace.path]);

  const handleCommand = useCallback(async (cmd, arg) => {
    if (cmd === "/exit") process.exit(0);
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
    if (cmd === "/sessions" || cmd === "/continue") {
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
      currentSessionRef.current.agentState = agentRef.current.compact();
      currentSessionRef.current = sessionStoreRef.current.save(currentSessionRef.current);
      appendArchived({ id: nextId(), type: "answer", content: "Session context compacted." });
      return;
    }
    if (cmd === "/export") {
      const path = resolve(workspace.path, arg || `khazai-session-${currentSessionRef.current.id.slice(0, 8)}.md`);
      sessionStoreRef.current.exportMarkdown(currentSessionRef.current, path);
      appendArchived({ id: nextId(), type: "answer", content: `Session exported to ${path}.` });
      return;
    }
    if (cmd === "/details") {
      const latest = completedRef.current.findLast(message => message.type === "tool");
      setExpandedTool(current => current ? null : latest ? { ...latest, id: `expanded-${latest.id}`, expanded: true } : null);
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
      const commandArgs = String(arg || "").trim();
      const [action, server] = commandArgs ? commandArgs.split(/\s+/, 2) : ["list", undefined];
      const refresh = async () => {
        const state = agentRef.current?.exportSessionState?.() || null;
        mcpToolsRef.current = await mcpManager.refresh();
        agentRef.current = new Agent(buildRegistry(workspace.path, mcpToolsRef.current), {
          workspace: workspace.path,
          sessionId: currentSessionRef.current.id,
          model: currentModel,
          agent: currentSessionRef.current.agent,
          sessionState: state,
          autoApprove: autoApproveRef.current,
          partHandler: part => sessionStoreRef.current.updatePart(part.sessionId, part),
        });
      };
      try {
        if (action === "refresh") {
          await refresh();
          appendArchived({ id: nextId(), type: "answer", content: "MCP servers refreshed." });
          return;
        }
        if (action === "auth") {
          if (!server) throw new Error("Usage: /mcp auth <server>");
          const configured = loadConfig(workspace.path).mcp?.[server];
          if (!configured) throw new Error(`MCP server "${server}" is not configured.`);
          if (!configured.url && configured.type !== "http" && configured.transport !== "http") {
            throw new Error("Stored MCP credentials are only supported for remote servers.");
          }
          const credential = await requestValue(`Credential for MCP server ${server}`, [], { secret: true });
          if (!credential) return;
          saveCredential(`mcp:${server}`, credential);
          await refresh();
          appendArchived({ id: nextId(), type: "answer", content: `Credential saved for MCP server ${server}.` });
          return;
        }
        if (action === "logout") {
          if (!server) throw new Error("Usage: /mcp logout <server>");
          removeCredential(`mcp:${server}`);
          await refresh();
          appendArchived({ id: nextId(), type: "answer", content: `Credential removed for MCP server ${server}.` });
          return;
        }
        if (action !== "list" && action !== "status") throw new Error("Usage: /mcp [list|status|refresh|auth <server>|logout <server>]");
        const status = mcpManager.status();
        const content = status.length
          ? ["MCP servers:", ...status.map(item =>
              `- ${item.id}: ${item.state} · ${item.type} · ${item.toolCount} tool${item.toolCount === 1 ? "" : "s"}${item.pid ? ` · PID ${item.pid}` : ""}${item.error ? ` — ${item.error}` : ""}`
            )].join("\n")
          : "No MCP servers are configured.";
        appendArchived({ id: nextId(), type: "answer", content });
      } catch (error) {
        appendArchived({ id: nextId(), type: "error", content: redactSecrets(error.message) });
      }
      return;
    }
    if (cmd === "/theme" && arg) {
      try {
        const selected = saveTheme(arg);
        setThemeName(selected);
        appendArchived({ id: nextId(), type: "answer", content: `Theme changed to **${selected}**.` });
      } catch (error) {
        appendArchived({ id: nextId(), type: "error", content: error.message });
      }
      return;
    }
    if (cmd === "/syntax-theme") {
      try {
        const choices = SYNTAX_THEMES.map(([value, label]) => ({ label, value }));
        const selected = arg || await requestValue(
          "Select syntax theme",
          choices.map(choice => choice.label),
          { values: choices },
        );
        if (!selected) return;
        const value = saveSyntaxTheme(selected);
        setSyntaxThemeName(value);
        appendArchived({ id: nextId(), type: "answer", content: `Syntax theme changed to **${value}**.` });
      } catch (error) {
        appendArchived({ id: nextId(), type: "error", content: error.message });
      }
      return;
    }
    if (cmd === "/help") {
      appendArchived({ id: nextId(), type: "answer", content: `# Commands\n\n${formatCommandHelp()}` });
    }
    if (cmd === "/expand") {
      const latest = completedRef.current.findLast(message => message.type === "tool");
      setExpandedTool(latest ? { ...latest, id: `expanded-${latest.id}`, expanded: true } : null);
    }
    if (cmd === "/collapse") setExpandedTool(null);
  }, [appendArchived, currentModel, loadStoredSession, mcpManager, requestValue, workspace.path]);

  const submit = useCallback(async (input, options = {}) => {
    const retryProvider = Boolean(options.retryProvider);
    if ((!retryProvider && !input.trim()) || submittingRef.current) return;
    setExpandedTool(null);
    structuredCallsRef.current.clear();
    submittingRef.current = true;
    const startedAt = Date.now();
    setRunning(true);
    setRunningStartedAt(startedAt);
    let finishedNormally = false;
    let finalCommitted = false;
    let fatalError = "";
    let recoverableFailure = false;
    const sessionBefore = currentSessionRef.current;
    const runId = nextId();
    const turnId = `${sessionBefore?.id || "session"}-${runId}`;
    if (!retryProvider) taskEpochRef.current++;
    const analysisScope = { runId, turnId, taskEpoch: taskEpochRef.current };
    activeScopeRef.current = analysisScope;
    cancelledRunIdRef.current = null;
    analysisRef.current = createAnalysisActivity({
      ...analysisScope,
      analysisId: `analysis-${turnId}`,
    });
    responseBufferRef.current = createResponseBuffer(analysisScope);
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
    const finishReadBatch = (failed, failurePreview = "") => {
      const current = activeRef.current;
      if (current?.type !== "read-group") return false;
      const completedAt = Date.now();
      clearActive();
      appendArchived({
        ...current,
        done: true,
        failed: Boolean(failed),
        failurePreview: failed ? failurePreview || "Error: Read failed" : "",
        currentFile: failed ? current.currentFile : "",
        completedAt,
        duration: completedAt - current.startedAt,
      });
      return true;
    };
    const recordReadResult = (callId, result) => {
      const current = activeRef.current;
      if (
        current?.type !== "read-group"
        || !current.callIds.includes(callId)
        || current.completedCallIds.includes(callId)
      ) return;
      const lineCount = Number(/^Lines:\s*(\d+)/im.exec(String(result || ""))?.[1] || 0);
      activate({
        ...current,
        completedCallIds: [...current.completedCallIds, callId],
        totalLines: current.totalLines + lineCount,
      });
    };
    const startRead = (callId, args, startedAt = Date.now(), status = "running") => {
      const current = activeRef.current;
      const currentFile = readFileName(args);
      pauseAnalysis();
      if (current?.type === "read-group") {
        const existing = current.callIds.includes(callId);
        const next = {
          ...current,
          args,
          currentFile,
          callIds: existing ? current.callIds : [...current.callIds, callId],
          count: existing ? current.count : current.count + 1,
          status,
        };
        activate(next);
        return;
      }
      activate({
        id: nextId(),
        type: "read-group",
        tool: "read",
        args,
        callIds: [callId],
        completedCallIds: [],
        count: 1,
        totalLines: 0,
        currentFile,
        startedAt,
        done: false,
        status,
      });
    };
    const completeStreaming = () => {
      const committed = commitResponseBuffer(responseBufferRef.current, analysisScope);
      responseBufferRef.current = committed.state;
      if (!committed.response) return false;
      const content = normalizeStreamText(agent.redactForDisplay(committed.response.content));
      if (!content) return false;
      appendArchived({ id: committed.response.id, type: "answer", content });
      finalCommitted = true;
      return true;
    };
    const resetStreaming = () => {
      responseBufferRef.current = resetResponseBuffer(responseBufferRef.current, analysisScope);
    };
    const discardStreaming = () => {
      responseBufferRef.current = discardResponseBuffer(responseBufferRef.current, analysisScope);
    };
    if (!retryProvider) {
      appendArchived({ id: nextId(), type: "user", content: redactSecrets(input) });
    }

    const agent = agentRef.current;
    agent.setQuestionHandler(() => new Promise(resolve => {
      questionResolverRef.current = { kind: "question", resolve, scope: analysisScope };
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
    const agentInput = retryProvider
      ? ""
      : input.trimStart().startsWith("!")
      ? input
      : attachFileReferences(input, workspace.path);
    for await (const ev of agent.loop(agentInput, undefined, {
      ...analysisScope,
      retryProvider,
    })) {
      if (cancelledRunIdRef.current === analysisScope.runId) continue;
      if (!analysisEventIsCurrent(ev, analysisScope)) continue;
      if (ev.type === "thinking") {
        resetStreaming();
        finishReadBatch(false);
        showAnalysis(thinkActivityFromPlan(planRef.current, ev.phase));
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
        finishReadBatch(false);
        pauseAnalysis();
        clearActive();
        setPlan(ev.items.map(item => ({ ...item, status: item.status || "pending" })));
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
        finishReadBatch(false);
        pauseAnalysis();
        appendArchived({
          id: nextId(),
          type: "answer",
          content: removeEmoji(ev.question).trim(),
        });
        setPendingQuestion({ question: ev.question, options: ev.options });
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
          finishReadBatch(false);
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
          if (failed) finishReadBatch(true, safeResult);
          else recordReadResult(part.callId, safeResult);
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
          finishReadBatch(false);
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
        finishReadBatch(false);
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
        });
        continue;
      }

      if (ev.type === "stream") {
        finishReadBatch(false);
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
        finishReadBatch(false);
        resetStreaming();
        continue;
      }

      if (ev.type === "tool-result") {
        if (ev.tool === "think") continue;
        if (ev.callId && structuredCallsRef.current.has(ev.callId)) continue;
        const current = activeRef.current;
        const duration = current?.startedAt ? Date.now() - current.startedAt : null;
        const safeResult = agent.redactForDisplay(ev.result);
        if (isInternalAgentFailure(safeResult)) {
          // Legacy tools may still return a guard phrase as text. The agent
          // converts current guards to steering; this protects the UI while a
          // plugin/tool is being migrated and avoids a duplicate error card.
          clearActive();
          continue;
        }
        const resultSize = Buffer.byteLength(safeResult || "");
        const failed = toolResultFailed(safeResult);
        if (ev.tool === "read") {
          if (failed) finishReadBatch(true, safeResult);
          else recordReadResult(ev.callId, safeResult);
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

      // Steering is orchestration metadata. It changes the next model turn but
      // must never become an assistant/error card in the normal UI.
      if (ev.type === "steering") continue;

      if (ev.type === "answer" || ev.type === "error") {
        if (isInternalAgentFailure(ev.content)) continue;
        discardStreaming();
        finishReadBatch(false);
        const safeContent = removeAssistantProtocolText(agent.redactForDisplay(removeEmoji(ev.content))).trim();
        const thinkTimeout = ev.type === "error" && /Analysis timed out|timed out/i.test(safeContent);
        if (ev.type === "answer") {
          pauseAnalysis();
          finishedNormally = true;
          setPlan([]);
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
          appendArchived({
            id: nextId(),
            type: ev.recoverable ? "provider-error" : ev.type,
            content: safeContent,
          });
          if (ev.type === "answer") finalCommitted = true;
        }
        continue;
      }

      if (ev.type === "stream-end") {
        finishReadBatch(false);
        pauseAnalysis();
        completeStreaming();
        setPlan([]);
        finishedNormally = true;
        continue;
      }
    }
    } catch (error) {
      discardStreaming();
      finishReadBatch(true);
      pauseAnalysis();
      analysisRef.current = clearAnalysisActivity(analysisRef.current, analysisScope);
      clearActive();
      const content = removeAssistantProtocolText(agent.redactForDisplay(error?.message || String(error))).trim();
      if (content) {
        fatalError = `Unexpected error: ${content}`;
        appendArchived({ id: nextId(), type: "error", content: fatalError });
      }
    } finally {
      agentSessionRef.current = agent.exportSessionState?.() || null;
      discardStreaming();
      finishReadBatch(false);
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
      setRunningStartedAt(null);
      setWorkspaceFiles(listWorkspaceFiles(workspace.path));
      const runResult = recoverableFailure ? null : terminalRunResult({
        cancelled: cancelledRunIdRef.current === runId,
        completionGaps: agent._executionPolicy?.completionGaps?.() || [],
        fatalError,
        finalCommitted,
        finishedNormally,
      });
      if (runResult?.status === "failed" && runResult.unresolvedIssues.length) {
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
          });
        } else {
          if (session.turns.length === 0) session.title = redactSecrets(input).slice(0, 72);
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
    }
  }, [appendArchived]);
  submitRef.current = submit;

  const answerQuestion = useCallback(answer => {
    const pending = questionResolverRef.current;
    const value = String(answer || "").trim();
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
    const secret = Boolean(pendingQuestion?.secret);
    questionResolverRef.current = null;
    setPendingQuestion(null);
    if (pending.kind !== "permission") {
      appendArchived({ id: nextId(), type: "user", content: secret ? "[credential provided]" : value });
    }
    pending.resolve(value);
  }, [appendArchived, pendingQuestion]);

  const cancelQuestion = useCallback(() => {
    const pending = questionResolverRef.current;
    if (!pending) return;
    questionResolverRef.current = null;
    setPendingQuestion(null);
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
    appendArchived({ id: nextId(), type: "answer", content: "Interrupted by user." });
    agentRef.current?.abort();
  }, [appendArchived, setPlan]);

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
  const showWorking = running && !activeMessage;

  return h(ThemeProvider, { name: themeName, syntaxTheme: syntaxThemeName }, h(Box, { flexDirection: "column", width: "100%" },
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
        ? h(MessageList, { messages: [displayedActiveMessage] })
        : null,
      expandedTool && !running
        ? h(MessageList, { messages: [expandedTool] })
        : null,
      completedMessages.length === 0 && !activeMessage && !pendingQuestion && plan.length === 0
        ? h(EmptyState)
        : null,
      h(PlanList, { plan: visiblePlan }),
      h(SessionFooter, {
        running: showWorking,
        plan: visiblePlan,
        activeTool: activeMessage?.type === "tool" ? activeMessage : null,
        startedAt: runningStartedAt,
        waitingForAnswer: Boolean(pendingQuestion),
        promptProps: {
          onSubmit: pendingQuestion ? answerQuestion : submit,
          onCommand: handleCommand,
          onClear: clearDisplay,
          onAbort: handleAbort,
          commands: COMMANDS,
          disabled: running && !pendingQuestion,
          activeModel: currentModel,
          questionOptions: pendingQuestion?.options || [],
          questionKind: pendingQuestion?.kind || "",
          permissionRequest: pendingQuestion?.permissionRequest || null,
          onSelectOption: answerQuestion,
          onCancelOption: cancelQuestion,
          secret: Boolean(pendingQuestion?.secret),
          fileItems: workspaceFiles,
        },
      }),
    ),
  ));
}
