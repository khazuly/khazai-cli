import { nextId } from "./session-runtime.js";

export async function handlePermissionCommand(cmd, arg, context) {
  const {
    appendArchived,
    permissionService,
    requestValue,
    workspacePath,
  } = context;
  const service = typeof permissionService === "function" ? permissionService() : permissionService;
  if (!service) {
    appendArchived({ id: nextId(), type: "error", content: "Permission manager is unavailable." });
    return;
  }
  const action = String(arg || "").trim().toLowerCase();
  if (cmd === "/allow-all") {
    if (action === "off") {
      await service.setAllowAll(false);
      appendArchived({ id: nextId(), type: "answer", content: `Allow-all disabled for ${workspacePath}.` });
      return;
    }
    if (action === "status") {
      const state = service.permissionState();
      appendArchived({
        id: nextId(),
        type: "answer",
        content: state.allowAll
          ? `Allow-all is enabled for ${workspacePath}.`
          : `Allow-all is disabled for ${workspacePath}.`,
      });
      return;
    }
    if (action && action !== "on") {
      appendArchived({ id: nextId(), type: "error", content: "Usage: /allow-all [status|off]" });
      return;
    }
    const choice = await requestValue(
      "Enable allow-all for this workspace?",
      ["Cancel", "Enable allow-all"],
      {
        archive: false,
        kind: "permissions",
        context: [
          `Workspace  ${workspacePath}`,
          "",
          "KhazAI will run supported tools inside this workspace without asking for approval.",
        ].join("\n"),
        values: [
          { label: "Cancel", value: "cancel" },
          { label: "Enable allow-all", value: "enable" },
        ],
      },
    );
    if (choice !== "enable") return;
    await service.setAllowAll(true);
    appendArchived({ id: nextId(), type: "answer", content: `Allow-all enabled for ${workspacePath}.` });
    return;
  }
  if (cmd === "/permissions") {
    if (action === "list") {
      const state = service.permissionState();
      const lines = [`Allow-all  ${state.allowAll ? "Enabled" : "Disabled"}`];
      for (const rule of state.rules) {
        lines.push(`${rule.id}  ${rule.action}  ${rule.path}  ${rule.scope}`);
      }
      if (!state.rules.length) lines.push("No permission rules.");
      appendArchived({ id: nextId(), type: "answer", content: lines.join("\n") });
      return;
    }
    if (action === "revoke" || action.startsWith("revoke ")) {
      const id = action === "revoke" ? "" : action.slice("revoke ".length).trim();
      if (!id) {
        appendArchived({ id: nextId(), type: "error", content: "Usage: /permissions revoke <rule-id>" });
        return;
      }
      const state = service.permissionState();
      if (!state.rules.some(rule => rule.id === id)) {
        appendArchived({ id: nextId(), type: "error", content: `No permission rule with id "${id}".` });
        return;
      }
      const confirmed = await requestValue(
        `Revoke permission rule ${id}?`,
        ["Cancel", "Revoke"],
        {
          archive: false,
          kind: "permissions",
          values: [
            { label: "Cancel", value: "cancel" },
            { label: "Revoke", value: "revoke" },
          ],
        },
      );
      if (confirmed !== "revoke") return;
      await service.revokeRule(id);
      appendArchived({ id: nextId(), type: "answer", content: `Permission rule ${id} revoked.` });
      return;
    }
    if (action === "reset") {
      const confirmed = await requestValue(
        "Reset all workspace permissions?",
        ["Cancel", "Reset"],
        {
          archive: false,
          kind: "permissions",
          context: "All persisted permission rules and allow-all will be removed for this workspace.",
          values: [
            { label: "Cancel", value: "cancel" },
            { label: "Reset", value: "reset" },
          ],
        },
      );
      if (confirmed !== "reset") return;
      await service.resetPermissions();
      appendArchived({ id: nextId(), type: "answer", content: "Workspace permissions reset." });
      return;
    }
    if (action) {
      appendArchived({ id: nextId(), type: "error", content: "Usage: /permissions [list|revoke <rule-id>|reset]" });
      return;
    }
    let state = service.permissionState();
    const options = [];
    const values = [];
    if (state.allowAll) {
      options.push("Disable allow-all");
      values.push({ label: "Disable allow-all", value: "disable-allow-all" });
    }
    for (const rule of state.rules) {
      const label = `${rule.action}  ${rule.path}`;
      options.push(label);
      values.push({ label, value: `revoke:${rule.id}` });
    }
    options.push("Reset workspace permissions");
    values.push({ label: "Reset workspace permissions", value: "reset" });
    options.push("Close");
    values.push({ label: "Close", value: "close" });
    const choice = await requestValue(`Permissions · ${workspacePath}`, options, {
      archive: false,
      kind: "permissions",
      context: `Allow-all  ${state.allowAll ? "Enabled" : "Disabled"}`,
      values,
    });
    if (!choice || choice === "close") return;
    if (choice === "disable-allow-all") {
      await service.setAllowAll(false);
      appendArchived({ id: nextId(), type: "answer", content: `Allow-all disabled for ${workspacePath}.` });
      return;
    }
    if (choice === "reset") {
      const confirmed = await requestValue(
        "Reset all workspace permissions?",
        ["Cancel", "Reset"],
        {
          archive: false,
          kind: "permissions",
          values: [
            { label: "Cancel", value: "cancel" },
            { label: "Reset", value: "reset" },
          ],
        },
      );
      if (confirmed !== "reset") return;
      await service.resetPermissions();
      appendArchived({ id: nextId(), type: "answer", content: "Workspace permissions reset." });
      return;
    }
    if (choice.startsWith("revoke:")) {
      const id = choice.slice("revoke:".length);
      const confirmed = await requestValue(
        `Revoke permission rule ${id}?`,
        ["Cancel", "Revoke"],
        {
          archive: false,
          kind: "permissions",
          values: [
            { label: "Cancel", value: "cancel" },
            { label: "Revoke", value: "revoke" },
          ],
        },
      );
      if (confirmed !== "revoke") return;
      await service.revokeRule(id);
      appendArchived({ id: nextId(), type: "answer", content: `Permission rule ${id} revoked.` });
      return;
    }
    return;
  }
}

