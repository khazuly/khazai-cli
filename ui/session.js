import { createElement as h } from "react";
import { useState, useRef, useCallback } from "react";
import { Box, Static, useStdout } from "ink";
import { resolve } from "node:path";
import { Agent } from "../app/agent.js";
import { validationCommand } from "../app/execution-policy.js";
import { PermissionService } from "../app/permission.js";
import { Registry } from "../app/registry.js";
import { SessionStore } from "../app/session-store.js";
import { builtinTools } from "../app/builtin-tools.js";
import { loadAgentProfiles } from "../app/agent-profiles.js";
import { listSkills } from "../app/skills.js";
import { lspStatus } from "../app/lsp.js";
import { configuredModels, loadConfig, saveModel, saveProvider, saveTheme } from "../config/index.js";
import { removeCredential, saveCredential, saveProviderCredential } from "../lib/auth.js";
import { listModels } from "../lib/llm.js";
import { COMMANDS } from "./commands.js";
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
import { attachFileReferences, listWorkspaceFiles } from "./file-reference.js";

function buildRegistry(workspace, mcpTools = []) {
  const r = new Registry();
  for (const tool of [...builtinTools(workspace), ...mcpTools].filter(Boolean)) r.register(tool);
  return r;
}

let msgId = 0;
function nextId() { return `m${++msgId}`; }

export function normalizeStreamText(text) {
  return normalizeVerticalWhitespace(removeAssistantProtocolText(removeEmoji(text)));
}

export function shouldShowCompletionSummary({ mutatedFiles, failedTools }) {
  return Number(failedTools) > 0 || Number(mutatedFiles?.size || mutatedFiles?.length || 0) > 0;
}

export function streamViewportText(text, columns, maximumRows) {
  const source = String(text || "");
  const width = Math.max(8, Math.trunc(Number(columns) || 80) - 1);
  const rowLimit = Math.max(1, Math.trunc(Number(maximumRows) || 1));
  const physicalRows = [];
  for (const line of source.split("\n")) {
    const characters = Array.from(line);
    if (characters.length === 0) {
      physicalRows.push("");
      continue;
    }
    for (let offset = 0; offset < characters.length; offset += width) {
      physicalRows.push(characters.slice(offset, offset + width).join(""));
    }
  }
  if (physicalRows.length <= rowLimit) return source;
  if (rowLimit === 1) {
    const tail = physicalRows.at(-1) || "";
    return `… ${tail}`.slice(0, width);
  }
  return ["…", ...physicalRows.slice(-(rowLimit - 1))].join("\n");
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
  const { stdout } = useStdout();
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
  const [plan, setPlan] = useState([]);
  const [running, setRunning] = useState(false);
  const [runningStartedAt, setRunningStartedAt] = useState(null);
  const [currentModel, setCurrentModel] = useState(currentSessionRef.current.model);
  const [themeName, setThemeName] = useState(initialConfig.current.theme || "system");
  const [workspaceFiles, setWorkspaceFiles] = useState(() => listWorkspaceFiles(workspace.path));
  const [sessionKey, setSessionKey] = useState(0);
  const [pendingQuestion, setPendingQuestion] = useState(null);
  const [expandedTool, setExpandedTool] = useState(null);
  const agentRef = useRef(null);
  const activeRef = useRef(null);
  const toolStartRef = useRef(null);
  const submittingRef = useRef(false);
  const questionResolverRef = useRef(null);
  const streamBufferRef = useRef("");
  const streamTimerRef = useRef(null);
  const completedRef = useRef([]);
  const agentSessionRef = useRef(null);
  const mcpToolsRef = useRef(initialMcpTools);
  const autoApproveRef = useRef(false);
  const structuredCallsRef = useRef(new Set());

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
    questionResolverRef.current = answer => resolveValue(values.get(answer) ?? answer);
    setPendingQuestion({
      question,
      options,
      secret: Boolean(settings.secret),
      kind: settings.kind || "command",
    });
  }), []);

  const loadStoredSession = useCallback(session => {
    currentSessionRef.current = session;
    agentSessionRef.current = session.agentState || null;
    agentRef.current = new Agent(buildRegistry(workspace.path, mcpToolsRef.current), {
      workspace: workspace.path,
      sessionId: session.id,
      model: session.model,
      agent: session.agent,
      sessionState: session.agentState,
      autoApprove: autoApproveRef.current,
      partHandler: part => sessionStoreRef.current.updatePart(part.sessionId, part),
    });
    completedRef.current = session.messages || [];
    activeRef.current = null;
    setCompletedMessages(session.messages || []);
    setActiveMessage(null);
    setPlan([]);
    setExpandedTool(null);
    setCurrentModel(session.model);
    setSessionKey(key => key + 1);
  }, [workspace.path]);

  const handleCommand = useCallback(async (cmd, arg) => {
    if (cmd === "/exit") process.exit(0);
    if (cmd === "/auto") {
      const requested = String(arg || "").trim().toLowerCase();
      autoApproveRef.current = requested
        ? ["on", "true", "1", "enable", "enabled"].includes(requested)
        : !autoApproveRef.current;
      agentRef.current?.setAutoApprove(autoApproveRef.current);
      appendArchived({
        id: nextId(),
        type: "answer",
        content: `Auto-approve is ${autoApproveRef.current ? "enabled" : "disabled"}. Explicit deny rules still apply.`,
      });
      return;
    }
    const chooseModel = async requested => {
      const models = configuredModels();
      const selected = requested || await requestValue("Select a model", models);
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
      appendArchived({ id: nextId(), type: "answer", content: `Model changed to ${selected}.` });
    };
    if (cmd === "/model" || cmd === "/models") {
      await chooseModel(arg);
      return;
    }
    if (cmd === "/connect") {
      try {
        const provider = arg || await requestValue("Provider ID");
        if (!provider) return;
        const baseURL = await requestValue("OpenAI-compatible base URL");
        if (!/^https?:\/\//i.test(baseURL)) throw new Error("The provider base URL must use HTTP or HTTPS.");
        const env = `${provider.replace(/[^a-z0-9]/gi, "_").toUpperCase()}_API_KEY`;
        const apiKey = await requestValue("API key", [], { secret: true });
        saveProvider(provider, { type: "openai-compatible", baseURL, env: env || undefined, models: [] });
        if (apiKey) saveProviderCredential(provider, apiKey);
        let models = [];
        try { models = await listModels(provider); } catch {}
        if (models.length === 0) {
          const manual = await requestValue("Model ID");
          if (manual) models = [manual];
        }
        saveProvider(provider, { type: "openai-compatible", baseURL, env: env || undefined, models });
        appendArchived({
          id: nextId(),
          type: "answer",
          content: `Connected provider ${provider}${models.length ? ` with ${models.length} model${models.length === 1 ? "" : "s"}` : ""}.`,
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
        appendArchived({ id: nextId(), type: "answer", content: "No saved sessions were found." });
        return;
      }
      const values = sessions.map(session => ({
        label: `${session.title} · ${session.model} · ${session.id.slice(0, 8)}`,
        value: session.id,
      }));
      const id = arg || await requestValue("Select a session", values.map(entry => entry.label), { values });
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
    if (cmd === "/help") {
      const list = COMMANDS.map(c => `\`${c.name}\` — ${c.description}`).join("\n");
      appendArchived({ id: nextId(), type: "answer", content: `**Commands:**\n${list}` });
    }
    if (cmd === "/expand") {
      const latest = completedRef.current.findLast(message => message.type === "tool");
      setExpandedTool(latest ? { ...latest, id: `expanded-${latest.id}`, expanded: true } : null);
    }
    if (cmd === "/collapse") setExpandedTool(null);
  }, [appendArchived, currentModel, loadStoredSession, mcpManager, requestValue, workspace.path]);

  const submit = useCallback(async (input) => {
    // React state updates are asynchronous; the ref closes the gap before the
    // disabled prop is rendered and prevents two loops mutating one Agent.
    if (!input.trim() || submittingRef.current) return;
    setExpandedTool(null);
    submittingRef.current = true;
    const startedAt = Date.now();
    setRunning(true);
    setRunningStartedAt(startedAt);
    let taskTools = 0;
    let failedTools = 0;
    let finishedNormally = false;
    const mutatedFiles = new Set();
    const validations = [];
    const sessionBefore = currentSessionRef.current;
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
    const flushStream = () => {
      if (streamTimerRef.current) {
        clearTimeout(streamTimerRef.current);
        streamTimerRef.current = null;
      }
      const buffered = streamBufferRef.current;
      streamBufferRef.current = "";
      const current = activeRef.current;
      if (!buffered || current?.type !== "streaming") return;
      const next = { ...current, content: normalizeStreamText(current.content + buffered) };
      activeRef.current = next;
      setActiveMessage(next);
    };
    const completeStreaming = () => {
      flushStream();
      const current = activeRef.current;
      if (current?.type === "streaming") {
        clearActive();
        appendArchived({ id: nextId(), type: "answer", content: current.content });
        return true;
      }
      return false;
    };
    const discardStreaming = () => {
      if (streamTimerRef.current) {
        clearTimeout(streamTimerRef.current);
        streamTimerRef.current = null;
      }
      streamBufferRef.current = "";
      if (activeRef.current?.type === "streaming") clearActive();
    };
    const recordToolEvidence = (tool, args, result, failed, duration) => {
      taskTools++;
      if (failed) failedTools++;
      if (["write", "edit"].includes(tool) && args?.path) mutatedFiles.add(String(args.path));
      if (tool === "apply_patch") {
        for (const match of String(args?.patchText || "").matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
          mutatedFiles.add(match[1]);
        }
      }
      if (tool === "bash" && validationCommand(args?.command)) {
        const exitCode = Number(/^Exit:\s*(-?\d+)/im.exec(String(result || ""))?.[1] ?? (failed ? -1 : 0));
        const command = String(args.command).trim();
        if (!validations.some(validation => validation.command === command)) {
          validations.push({
            command,
            exitCode,
            duration: duration === null || duration === undefined
              ? null
              : duration < 1000 ? `${Math.round(duration)} ms` : `${(duration / 1000).toFixed(1)} s`,
          });
        }
      }
    };

    appendArchived({ id: nextId(), type: "user", content: redactSecrets(input) });

    const agent = agentRef.current;
    agent.setQuestionHandler(() => new Promise(resolve => {
      questionResolverRef.current = resolve;
    }));
    agent.setPermissionHandler(() => new Promise(resolve => {
      questionResolverRef.current = resolve;
    }));
    try {
    const agentInput = input.trimStart().startsWith("!")
      ? input
      : attachFileReferences(input, workspace.path);
    for await (const ev of agent.loop(agentInput)) {
      if (ev.type === "thinking") {
        continue;
      }

      if (ev.type === "plan") {
        discardStreaming();
        clearActive();
        setPlan(ev.items.map(item => ({ ...item, status: "pending" })));
        continue;
      }

      if (ev.type === "plan-update") {
        setPlan(prev => prev.map((item, i) =>
          i === ev.index ? { ...item, status: ev.status } : item
        ));
        continue;
      }

      if (ev.type === "question") {
        const questionAlreadyStreamed = completeStreaming();
        clearActive();
        if (!questionAlreadyStreamed) {
          appendArchived({
            id: nextId(),
            type: "answer",
            content: removeEmoji(ev.question).trim(),
          });
        }
        setPendingQuestion({ question: ev.question, options: ev.options });
        continue;
      }

      if (ev.type === "permission") {
        discardStreaming();
        clearActive();
        appendArchived({
          id: nextId(),
          type: "permission",
          reason: redactSecrets(ev.reason),
          tool: ev.tool,
          target: redactSecrets(JSON.stringify(ev.args || {})),
        });
        setPendingQuestion({
          question: ev.reason,
          options: ev.options,
          kind: "permission",
        });
        continue;
      }

      if (ev.type === "tool-part") {
        const part = ev.part;
        if (!part || part.type !== "tool") continue;
        if (part.tool === "question") continue;
        structuredCallsRef.current.add(part.callId);
        if (part.state.status === "pending" || part.state.status === "running") {
          discardStreaming();
          if (activeRef.current?.type !== "tool") {
            toolStartRef.current = part.state.time?.start || Date.now();
            activate({
              id: nextId(),
              type: "tool",
              callId: part.callId,
              tool: part.tool,
              args: JSON.parse(redactSecrets(JSON.stringify(part.state.input || {}))),
              done: false,
            });
          }
          continue;
        }
        const safeResult = redactSecrets(
          part.state.status === "error" ? part.state.error : part.state.output,
        );
        const failed = part.state.status === "error";
        const duration = part.state.time?.end && part.state.time?.start
          ? part.state.time.end - part.state.time.start
          : null;
        recordToolEvidence(part.tool, part.state.input || {}, safeResult, failed, duration);
        const current = activeRef.current?.callId === part.callId ? activeRef.current : null;
        if (current) clearActive();
        appendArchived({
          ...(current || { id: nextId(), type: "tool", tool: part.tool, args: part.state.input || {} }),
          callId: part.callId,
          content: safeResult,
          done: true,
          failed,
          duration,
          resultSize: Buffer.byteLength(safeResult || ""),
          expanded: false,
        });
        continue;
      }

      if (ev.type === "tool-call") {
        if (ev.callId && structuredCallsRef.current.has(ev.callId)) continue;
        discardStreaming();
        toolStartRef.current = Date.now();
        activate({ id: nextId(), type: "tool", tool: ev.tool, args: JSON.parse(redactSecrets(JSON.stringify(ev.args || {}))), done: false });
        continue;
      }

      if (ev.type === "stream") {
        const current = activeRef.current;
        if (current?.type === "streaming") {
          streamBufferRef.current += ev.token;
          if (!streamTimerRef.current) {
            streamTimerRef.current = setTimeout(() => flushStream(), 40);
          }
        } else {
          const initial = normalizeStreamText(ev.token);
          if (!initial) continue;
          clearActive();
          activate({ id: nextId(), type: "streaming", content: initial });
        }
        continue;
      }

      if (ev.type === "stream-discard") {
        discardStreaming();
        continue;
      }

      if (ev.type === "tool-result") {
        if (ev.callId && structuredCallsRef.current.has(ev.callId)) continue;
        flushStream();
        const current = activeRef.current;
        const duration = toolStartRef.current ? Date.now() - toolStartRef.current : null;
        const safeResult = redactSecrets(ev.result);
        if (isInternalAgentFailure(safeResult)) {
          // Legacy tools may still return a guard phrase as text. The agent
          // converts current guards to steering; this protects the UI while a
          // plugin/tool is being migrated and avoids a duplicate error card.
          clearActive();
          continue;
        }
        const resultSize = Buffer.byteLength(safeResult || "");
        const failed = toolResultFailed(safeResult);
        recordToolEvidence(ev.tool, current?.args || {}, ev.result, failed, duration);
        clearActive();
        appendArchived(
          current?.type === "tool"
            ? { ...current, content: safeResult, done: true, failed, duration, resultSize, expanded: false }
            : { id: nextId(), type: "tool", tool: ev.tool, args: {}, content: safeResult, done: true, failed, duration, resultSize, expanded: false }
        );
        continue;
      }

      // Steering is orchestration metadata. It changes the next model turn but
      // must never become an assistant/error card in the normal UI.
      if (ev.type === "steering") continue;

      if (ev.type === "answer" || ev.type === "error") {
        if (isInternalAgentFailure(ev.content)) continue;
        discardStreaming();
        if (ev.type === "answer") {
          finishedNormally = true;
          setPlan([]);
        }
        const safeContent = removeAssistantProtocolText(redactSecrets(removeEmoji(ev.content))).trim();
        if (safeContent) appendArchived({ id: nextId(), type: ev.type, content: safeContent });
        continue;
      }

      if (ev.type === "stream-end") {
        flushStream();
        const current = activeRef.current;
        if (current?.type === "streaming") {
          clearActive();
          appendArchived({ id: nextId(), type: "answer", content: current.content });
        }
        setPlan([]);
        finishedNormally = true;
        continue;
      }
    }
    } catch (error) {
      completeStreaming();
      clearActive();
      // Agent recovery is represented by internal steering and persisted task
      // state. Do not turn an unexpected loop exception into a user-facing
      // failure card; the next continuation resumes the pending task.
    } finally {
      agentSessionRef.current = agent.exportSessionState?.() || null;
      completeStreaming();
      clearActive();
      questionResolverRef.current = null;
      setPendingQuestion(null);
      submittingRef.current = false;
      setRunning(false);
      setRunningStartedAt(null);
      setWorkspaceFiles(listWorkspaceFiles(workspace.path));
      if (taskTools > 0 && shouldShowCompletionSummary({ mutatedFiles, failedTools })) {
        appendArchived({
          id: nextId(),
          type: "summary",
          status: finishedNormally && failedTools === 0 ? "finished" : "attention",
          tools: taskTools,
          files: [...mutatedFiles],
          validations,
          validationMissing: mutatedFiles.size > 0 && validations.length === 0,
          duration: Date.now() - startedAt,
        });
      }
      const session = currentSessionRef.current;
      if (session?.id === sessionBefore?.id) {
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
  }, [appendArchived]);

  const answerQuestion = useCallback(answer => {
    const resolve = questionResolverRef.current;
    const value = String(answer || "").trim();
    if (!resolve || !value) return;
    const secret = Boolean(pendingQuestion?.secret);
    questionResolverRef.current = null;
    setPendingQuestion(null);
    appendArchived({ id: nextId(), type: "user", content: secret ? "[credential provided]" : value });
    resolve(value);
  }, [appendArchived, pendingQuestion]);

  const clearDisplay = useCallback(() => {
    process.stdout.write("\u001b[2J\u001b[H");
    completedRef.current = [];
    activeRef.current = null;
    setCompletedMessages([]);
    setActiveMessage(null);
    setPlan([]);
    setExpandedTool(null);
    setSessionKey(key => key + 1);
  }, []);

  const staticItems = [
    { id: `banner-${sessionKey}`, type: "banner" },
    ...completedMessages,
  ];
  const terminalColumns = Math.max(12, Number(stdout?.columns) || 80);
  const terminalRows = Math.max(8, Number(stdout?.actualRows || stdout?.rows) || 24);
  const planFinished = plan.length > 0
    && plan.every(item => ["done", "failed", "skipped"].includes(item.status));
  const visiblePlan = activeMessage?.type === "streaming" && planFinished ? [] : plan;
  const reservedRows = 9 + (visiblePlan.length ? visiblePlan.length + 3 : 0);
  const streamingRows = Math.max(1, terminalRows - reservedRows);
  const displayedActiveMessage = activeMessage?.type === "streaming"
    ? {
        ...activeMessage,
        content: streamViewportText(activeMessage.content, terminalColumns, streamingRows),
      }
    : activeMessage;
  const showWorking = running && activeMessage?.type !== "streaming";

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
          commands: COMMANDS,
          disabled: running && !pendingQuestion,
          activeModel: currentModel,
          questionOptions: pendingQuestion?.options || [],
          onSelectOption: answerQuestion,
          secret: Boolean(pendingQuestion?.secret),
          fileItems: workspaceFiles,
        },
      }),
    ),
  ));
}
