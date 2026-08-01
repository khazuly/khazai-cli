export async function handleSecondarySessionCommand(context, cmd, arg) {
  const { Agent, PermissionService, abortRef, agentRef, appendArchived, autoApproveRef, buildRegistry, buildStartedPlanIdRef, completedRef, configuredModels, contextUsageRef, currentModel, currentSessionRef, displayModel, formatCommandHelp, formatSessionList, formatUsageReport, handlePermissionCommand, initRunRef, listModels, listSkills, loadAgentProfiles, loadConfig, loadStoredSession, loginCodex, lspStatus, manageMcpCommand, mcpToolsRef, messageQueueRef, pendingQuestion, performExit, planRef, planWorkflowRef, planningQuestionRef, prepareInit, removeStoredSessions, requestValue, resolve, running, saveModel, saveProvider, saveProviderCredential, saveReasoningEffort, saveTheme, sessionManagerSessions, sessionStoreRef, setContextUsage, setCurrentModel, setExpandedTool, setModeStatus, setQueuedCount, setSessionManagerSessions, setSettingsSection, setShowSettings, setThemeName, showSettings, submitRef, submittingRef, themePreviewRef, workspace, nextId, randomUUID, setCompletedMessages, setActiveMessage, setPlanVisibility, setSessionKey, responseBufferRef, activeScopeRef } = context;
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
  if (["plan", "build"].includes(selected)) {
    agentRef.current.setMode(selected);
  } else {
    agentRef.current = new Agent(buildRegistry(workspace.path, mcpToolsRef.current), {
      workspace: workspace.path,
      sessionId: currentSessionRef.current.id,
      model: currentModel,
      agent: selected,
      sessionState: { ...state, agent: selected },
      autoApprove: autoApproveRef.current,
      partHandler: part => sessionStoreRef.current.updatePart(part.sessionId, part),
    });
  }
  currentSessionRef.current.agent = selected;
  currentSessionRef.current.agentState = agentRef.current.exportSessionState();
  currentSessionRef.current = sessionStoreRef.current.save(currentSessionRef.current);
  planWorkflowRef.current = null;
  planningQuestionRef.current = null;
  buildStartedPlanIdRef.current = null;
  setModeStatus(selected === "plan"
    ? { mode: "plan", status: "ready" }
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
}
