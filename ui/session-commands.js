import { resolve } from "node:path";
import { Agent } from "../app/agent.js";
import { PermissionService } from "../app/permission.js";
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
} from "../config/index.js";
import { saveProviderCredential } from "../lib/auth.js";
import { loginCodex } from "../lib/codex-auth.js";
import { listModels } from "../lib/llm.js";
import { formatCommandHelp } from "./commands.js";
import { manageMcpCommand } from "./mcp-command.js";
import { findToolMessage, recentToolMessages, toolChoice } from "./tool-activity.js";
import { buildRegistry, displayModel, nextId, permissionModeCommand } from "./session-runtime.js";

async function chooseModel(requested, context) {
  const {
    agentRef,
    appendArchived,
    autoApproveRef,
    currentSessionRef,
    mcpToolsRef,
    requestValue,
    sessionStoreRef,
    setCurrentModel,
    workspacePath,
  } = context;
  const models = configuredModels();
  const choices = models.map(model => ({ label: displayModel(model), value: model }));
  const selected = requested || await requestValue(
    "Select a model",
    choices.map(choice => choice.label),
    { values: choices },
  );
  if (!selected || !models.includes(selected)) {
    appendArchived({ id: nextId(), type: "error", content: `Model "${selected}" is not configured.` });
    return;
  }
  saveModel(selected);
  const state = agentRef.current?.exportSessionState?.() || null;
  agentRef.current = new Agent(buildRegistry(workspacePath, mcpToolsRef.current), {
    workspace: workspacePath,
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
}

async function connectProvider(arg, context) {
  const { appendArchived, requestValue } = context;
  try {
    const provider = String(arg || await requestValue(
      "Select a provider",
      ["Codex · ChatGPT OAuth", "Custom OpenAI-compatible"],
      {
        values: [
          { label: "Codex · ChatGPT OAuth", value: "codex" },
          { label: "Custom OpenAI-compatible", value: "custom" },
        ],
      },
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
      if (selected) await chooseModel(`codex/${selected}`, context);
      return;
    }
    if (provider !== "custom") throw new Error(`Unknown provider "${provider}".`);
    const customID = await requestValue("Provider ID");
    if (!customID) return;
    const baseURL = await requestValue("OpenAI-compatible base URL");
    if (!/^https?:\/\//i.test(baseURL)) throw new Error("The provider base URL must use HTTP or HTTPS.");
    const env = `${customID.replace(/[^a-z0-9]/gi, "_").toUpperCase()}_API_KEY`;
    const apiKey = await requestValue("API key", [], { secret: true });
    saveProvider(customID, { type: "openai-compatible", baseURL, env, models: [] });
    if (apiKey) saveProviderCredential(customID, apiKey);
    let models = [];
    try { models = await listModels(customID); } catch {}
    if (models.length === 0) {
      const manual = await requestValue("Model ID");
      if (manual) models = [manual];
    }
    saveProvider(customID, { type: "openai-compatible", baseURL, env, models });
    appendArchived({
      id: nextId(),
      type: "answer",
      content: `Connected provider ${customID}${models.length ? ` with ${models.length} model${models.length === 1 ? "" : "s"}` : ""}.`,
    });
  } catch (error) {
    appendArchived({ id: nextId(), type: "error", content: error.message });
  }
}

async function manageSessions(cmd, arg, context) {
  const {
    appendArchived,
    currentSessionRef,
    loadStoredSession,
    requestValue,
    sessionStoreRef,
  } = context;
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
  try {
    const result = cmd === "/undo"
      ? sessionStoreRef.current.undo(currentSessionRef.current)
      : sessionStoreRef.current.redo(currentSessionRef.current);
    loadStoredSession(result.session);
    if (result.warning) appendArchived({ id: nextId(), type: "answer", content: result.warning });
  } catch (error) {
    appendArchived({ id: nextId(), type: "error", content: error.message });
  }
}

async function showToolDetails(arg, context) {
  const { completedRef, requestValue, setInspectedTool } = context;
  const tools = recentToolMessages(completedRef.current);
  if (tools.length === 0) return;
  const requested = String(arg || "").trim();
  if (requested === "latest") {
    setInspectedTool(tools[0]);
    return;
  }
  if (requested) {
    const selected = findToolMessage(tools, requested);
    if (selected) setInspectedTool(selected);
    return;
  }
  const choices = tools.map((message, index) => ({
    label: `${index + 1}. ${toolChoice(message)}`,
    value: message.id,
  }));
  const selectedId = await requestValue(
    "Select tool details",
    choices.map(choice => choice.label),
    { values: choices },
  );
  setInspectedTool(findToolMessage(tools, selectedId));
}

async function selectAgent(arg, context) {
  const {
    agentRef,
    appendArchived,
    autoApproveRef,
    currentModel,
    currentSessionRef,
    mcpToolsRef,
    requestValue,
    sessionStoreRef,
    workspacePath,
  } = context;
  const profiles = [...loadAgentProfiles(workspacePath).values()].filter(profile => profile.role === "primary");
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
  agentRef.current = new Agent(buildRegistry(workspacePath, mcpToolsRef.current), {
    workspace: workspacePath,
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
}

async function manageMcp(arg, context) {
  const {
    agentRef,
    appendArchived,
    autoApproveRef,
    currentModel,
    currentSessionRef,
    mcpManager,
    mcpToolsRef,
    requestValue,
    sessionStoreRef,
    workspacePath,
  } = context;
  if (!mcpManager) {
    appendArchived({ id: nextId(), type: "answer", content: "No MCP manager is available." });
    return;
  }
  const syncTools = async tools => {
    const state = agentRef.current?.exportSessionState?.() || null;
    mcpToolsRef.current = tools;
    agentRef.current = new Agent(buildRegistry(workspacePath, mcpToolsRef.current), {
      workspace: workspacePath,
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
}

export async function handleSessionCommand(cmd, arg, context) {
  const {
    agentRef,
    appendArchived,
    autoApproveRef,
    completedRef,
    currentModel,
    currentSessionRef,
    sessionStoreRef,
    setInspectedTool,
    setThemeName,
    workspacePath,
  } = context;
  if (cmd === "/exit") return context.exit?.();
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
  if (cmd === "/model" || cmd === "/models") return chooseModel(arg, context);
  if (cmd === "/reasoning") {
    if (!String(currentModel).startsWith("codex/")) {
      appendArchived({ id: nextId(), type: "error", content: "Reasoning selection is available only for Codex models." });
      return;
    }
    const effort = arg || await context.requestValue("Select Codex reasoning effort", ["low", "medium", "high", "xhigh"]);
    if (!effort) return;
    const value = saveReasoningEffort(effort);
    agentRef.current?.setReasoningEffort(value);
    appendArchived({ id: nextId(), type: "answer", content: `Codex reasoning set to ${value}.` });
    return;
  }
  if (cmd === "/connect") return connectProvider(arg, context);
  if (["/new", "/sessions", "/continue", "/fork", "/undo", "/redo"].includes(cmd)) {
    return manageSessions(cmd, arg, context);
  }
  if (cmd === "/compact") {
    currentSessionRef.current.agentState = agentRef.current.compact();
    currentSessionRef.current = sessionStoreRef.current.save(currentSessionRef.current);
    appendArchived({ id: nextId(), type: "answer", content: "Session context compacted." });
    return;
  }
  if (cmd === "/export") {
    const path = resolve(workspacePath, arg || `khazai-session-${currentSessionRef.current.id.slice(0, 8)}.md`);
    sessionStoreRef.current.exportMarkdown(currentSessionRef.current, path);
    appendArchived({ id: nextId(), type: "answer", content: `Session exported to ${path}.` });
    return;
  }
  if (cmd === "/details") {
    const detailArg = String(arg || "").trim().toLowerCase();
    if (detailArg === "on" || detailArg === "expand") {
      const tools = recentToolMessages(context.completedRef.current);
      context.setInspectedTool(tools[0] || null);
    } else if (detailArg === "off" || detailArg === "collapse") {
      context.setInspectedTool(null);
    } else {
      return showToolDetails(arg, context);
    }
    return;
  }
  if (cmd === "/agent") return selectAgent(arg, context);
  if (cmd === "/skills") {
    const permissions = new PermissionService(workspacePath);
    const skills = listSkills(workspacePath).filter(skill =>
      permissions.evaluate("skill", { name: skill.name }).decision !== "deny"
    );
    const content = skills.length
      ? ["Discovered skills:", ...skills.map(skill =>
          `- ${skill.name} — ${skill.description} (${skill.scope}:${skill.namespace})`
        )].join("\n")
      : "No valid skills were discovered.";
    appendArchived({ id: nextId(), type: "answer", content });
    return;
  }
  if (cmd === "/lsp") {
    const status = lspStatus(workspacePath);
    const content = !status.enabled
      ? "LSP is disabled. Set `lsp` to `true` or configure servers in khazai-ai config."
      : ["Language servers:", ...status.servers.map(server =>
          `- ${server.id}: ${server.state}${server.pid ? ` (PID ${server.pid})` : ""} — ${server.extensions.join(", ")}`
        )].join("\n");
    appendArchived({ id: nextId(), type: "answer", content });
    return;
  }
  if (cmd === "/mcp") return manageMcp(arg, context);
  if (cmd === "/theme" && arg) {
    try {
      const selected = await saveTheme(arg);
      setThemeName(selected);
      appendArchived({ id: nextId(), type: "answer", content: `Theme saved: **${selected}**.` });
    } catch (error) {
      appendArchived({ id: nextId(), type: "error", content: error.message });
    }
    return;
  }
  if (cmd === "/help") {
    appendArchived({ id: nextId(), type: "answer", content: `# Commands\n\n${formatCommandHelp()}` });
    return;
  }
  if (cmd === "/expand") {
    const tools = recentToolMessages(completedRef.current);
    setInspectedTool(tools[0] || null);
    return;
  }
  if (cmd === "/collapse") {
    setInspectedTool(null);
    return;
  }
}
