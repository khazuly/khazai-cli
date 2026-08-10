export const PRIMARY_SESSION_COMMANDS = new Set(["/exit", "/queue", "/cancel", "/init", "/retry", "/allow-all", "/auto", "/permissions", "/model", "/models", "/reasoning", "/usage", "/setting", "/connect", "/new", "/sessions"]);

export async function handlePrimarySessionCommand(context, cmd, arg) {
  const { Agent, PermissionService, abortRef, agentRef, appendArchived, autoApproveRef, buildRegistry, buildStartedPlanIdRef, completedRef, configuredModels, contextUsageRef, currentModel, currentSessionRef, displayModel, formatCommandHelp, formatSessionList, formatUsageReport, handlePermissionCommand, initRunRef, listModels, listSkills, loadAgentProfiles, loadConfig, loadStoredSession, loginCodex, lspStatus, manageMcpCommand, mcpToolsRef, messageQueueRef, pendingQuestion, performExit, planRef, planWorkflowRef, planningQuestionRef, prepareInit, removeStoredSessions, requestValue, resolve, running, saveModel, saveProvider, saveProviderCredential, saveReasoningEffort, saveTheme, sessionManagerSessions, sessionStoreRef, setContextUsage, setCurrentModel, setExpandedTool, setModeStatus, setQueuedCount, setSessionManagerSessions, setSettingsSection, setShowSettings, setThemeName, showSettings, submitRef, submittingRef, themePreviewRef, workspace, nextId, randomUUID, setCompletedMessages, setActiveMessage, setPlanVisibility, setSessionKey, responseBufferRef, activeScopeRef } = context;
if (cmd === "/exit") {
  if (pendingQuestion || showSettings || sessionManagerSessions) {
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
  if (submittingRef.current || initRunRef.current.status === "running") {
    appendArchived({
      id: nextId(),
      type: "error",
      content: "This command is unavailable while a task is running.",
    });
    return;
  }
  let initialization;
  try {
    initialization = prepareInit(workspace.path);
  } catch {
    appendArchived({ id: nextId(), type: "error", content: "Could not resolve workspace root." });
    return;
  }
  if (initialization.status === "exists") {
    appendArchived({ id: nextId(), type: "answer", content: initialization.message });
    return;
  }
  return submitRef.current?.(initialization.task, {
    internalInput: true,
    initialization,
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
  await handlePermissionCommand(cmd === "/auto" ? "/allow-all" : cmd, requested, {
    appendArchived,
    requestValue,
    workspacePath: workspace.path,
    permissionService: () => agentRef.current?._permissionService || new PermissionService(workspace.path),
  });
  return;
}
if (cmd === "/permissions") {
  await handlePermissionCommand(cmd, arg, {
    appendArchived,
    requestValue,
    workspacePath: workspace.path,
    permissionService: () => agentRef.current?._permissionService || new PermissionService(workspace.path),
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
    partHandler: part => {
      sessionStoreRef.current.updatePart(part.sessionId, part, agentRef.current?.activeRunState?.());
    },
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
  const { formatModelStatusList, modelDetails, modelStatusList } = await import("./model-command.js");
  const parts = String(arg || "").trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] || "").toLowerCase();
  if (sub === "free" || sub === "list") {
    const list = await modelStatusList();
    appendArchived({ id: nextId(), type: "answer", content: formatModelStatusList(list) });
    return;
  }
  if (sub === "refresh") {
    const list = await modelStatusList({ force: true });
    appendArchived({
      id: nextId(),
      type: "answer",
      content: `Model availability refreshed.\n\n${formatModelStatusList(list)}`,
    });
    return;
  }
  if (sub === "details") {
    if (!parts[1]) {
      appendArchived({ id: nextId(), type: "error", content: "Usage: /model details <alias>" });
      return;
    }
    const details = await modelDetails(parts[1]);
    if (!details) {
      appendArchived({ id: nextId(), type: "error", content: `Model "${parts[1]}" is not a KhazAI free model.` });
      return;
    }
    appendArchived({ id: nextId(), type: "answer", content: details });
    return;
  }
  if (parts.length) {
    const alias = parts.join(" ");
    const list = await modelStatusList();
    const entry = list.find(model => (
      model.key === alias.toLowerCase()
      || model.alias === alias.toLowerCase()
      || String(model.displayName).toLowerCase() === alias.toLowerCase()
    ));
    if (!entry) {
      await chooseModel(alias);
      return;
    }
    await chooseModel(entry.key);
    if (entry.status !== "available") {
      appendArchived({
        id: nextId(),
        type: "answer",
        content: `${entry.displayName} is ${entry.statusLabel.toLowerCase()}. It remains selected.`,
      });
    }
    return;
  }
  const { EXCEPTIONAL_STATUSES, selectableModels } = await import("./model-command.js");
  const list = await selectableModels();
  const zenList = await modelStatusList();
  const choices = list.map(alias => {
    const entry = zenList.find(model => model.key === alias || model.alias === alias);
    const label = entry
      ? EXCEPTIONAL_STATUSES.has(entry.status)
        ? `${entry.displayName} (${entry.statusLabel})`
        : entry.displayName
      : displayModel(alias);
    return { label, value: alias };
  });
  const selected = await requestValue("Select a model", choices.map(choice => choice.label), {
    kind: "mcp",
    values: choices,
  });
  if (!selected) return;
  const entry = zenList.find(model => (
    model.key === selected || model.alias === selected
  ));
  await chooseModel(selected);
  if (entry && entry.status !== "available") {
    appendArchived({
      id: nextId(),
      type: "answer",
      content: `${entry.displayName} is ${entry.statusLabel.toLowerCase()}. It remains selected.`,
    });
  }
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
}
