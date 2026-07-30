import {
  configuredMcpServers,
  connectMcpServer,
  disconnectMcpServer,
  mcpCatalog,
  parseMcpPairs,
  removeManagedMcpServer,
  saveManagedMcpServer,
  setMcpServerEnabled,
  validateMcpServerDraft,
} from "../app/mcp-control.js";
import { getCredential, removeCredential, saveCredential } from "../lib/auth.js";
import { redactSecrets } from "../lib/secrets.js";

const ACTIONS = [
  "Connect",
  "Disconnect",
  "Show tools",
  "Show resources",
  "Show prompts",
  "Enable",
  "Disable",
  "Edit configuration",
  "Remove server",
];

function stateLabel(value) {
  return String(value || "disconnected").replace(/(^|-)([a-z])/g, (_, prefix, letter) =>
    `${prefix ? " " : ""}${letter.toUpperCase()}`);
}

function statusFor(manager, id) {
  const item = manager.status().find(server => server.id === id);
  if (!item) throw new Error(`MCP server "${id}" is not configured.`);
  return item;
}

function serverList(manager) {
  const status = new Map(manager.status().map(item => [item.id, item]));
  const configured = new Map(configuredMcpServers(manager.workspace).map(item => [item.id, item.value]));
  const ids = [...new Set([...configured.keys(), ...status.keys()])].sort();
  return ids.map(id => {
    const value = configured.get(id);
    const current = status.get(id) || {};
    return {
      id,
      type: current.type || (value?.url || value?.type === "http" ? "http" : "stdio"),
      state: current.state || (value?.enabled === false ? "disabled" : "disconnected"),
      tools: current.toolCount || 0,
      enabled: current.enabled ?? (value?.enabled !== false),
    };
  });
}

function listText(manager) {
  const servers = serverList(manager);
  if (servers.length === 0) return "No MCP servers are configured.";
  return [
    "# MCP Servers",
    ...servers.map(server => [
      `**${server.id}**`,
      `Transport  ${server.type}`,
      `Status     ${stateLabel(server.state)}`,
      `Tools      ${server.tools}`,
      `Enabled    ${server.enabled ? "Yes" : "No"}`,
    ].join("\n")),
  ].join("\n\n");
}

function statusText(manager, id) {
  if (!id) return listText(manager);
  const item = statusFor(manager, id);
  return [
    `# ${item.id}`,
    `Transport     ${item.type}`,
    `Status        ${stateLabel(item.state)}`,
    `Enabled       ${item.enabled ? "Yes" : "No"}`,
    `Capabilities  ${item.capabilities?.length ? item.capabilities.join(", ") : "None reported"}`,
    `Tools         ${item.toolCount || 0}`,
    `Resources     ${item.resourceCount || 0}`,
    `Prompts       ${item.promptCount || 0}`,
    ...(item.pid ? [`PID           ${item.pid}`] : []),
    ...(item.error ? [`Last error    ${redactSecrets(item.error)}`] : []),
  ].join("\n");
}

function splitArguments(value) {
  if (String(value).trim() === "-") return [];
  const result = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const character of String(value || "")) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = "";
      else current += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) result.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (quote) throw new Error("MCP arguments contain an unclosed quote.");
  if (escaped) current += "\\";
  if (current) result.push(current);
  return result;
}

async function optionalPairs(requestValue, label) {
  const action = await requestValue(label, ["Skip", "Configure"]);
  if (action !== "Configure") return {};
  const value = await requestValue(`${label} as comma-separated NAME=value entries`, [], { secret: true });
  return parseMcpPairs(value, label);
}

async function replacement(requestValue, label, current, settings = {}) {
  if (current !== undefined) {
    const action = await requestValue(label, ["Keep current", "Replace"]);
    if (action !== "Replace") return current;
  }
  return requestValue(label, [], settings);
}

async function serverWizard(context, editing) {
  const { manager, requestValue } = context;
  const configured = Object.fromEntries(configuredMcpServers(manager.workspace).map(item => [item.id, item.value]));
  const existing = editing ? configured[editing] : null;
  const id = editing || await requestValue("MCP Server Name");
  if (!id) return null;
  const existingTransport = existing
    ? existing.url || existing.type === "http" || existing.transport === "http" ? "http" : "stdio"
    : undefined;
  let transport = existingTransport;
  if (!transport) {
    transport = await requestValue("Transport", ["stdio", "http"]);
  } else {
    const action = await requestValue("Transport", ["Keep current", "Change"]);
    if (action === "Change") transport = await requestValue("Transport", ["stdio", "http"]);
  }
  const enabledAnswer = await requestValue("Auto-connect", ["Yes", "No"]);
  const draft = { id, transport, enabled: enabledAnswer === "Yes", editing: Boolean(editing) };
  if (transport === "stdio") {
    draft.command = await replacement(requestValue, "Command", existing?.command);
    const currentArgs = Array.isArray(existing?.command) ? existing.command.slice(1) : existing?.args;
    const argumentText = await replacement(
      requestValue,
      "Arguments (use - for none)",
      currentArgs ? currentArgs.join(" ") || "-" : undefined,
    );
    draft.args = splitArguments(argumentText);
    draft.env = existing?.env || existing?.environment || {};
    const envAction = await requestValue("Environment variables", ["Keep or skip", "Replace"]);
    if (envAction === "Replace") draft.env = await optionalPairs(requestValue, "Environment variables");
  } else {
    draft.url = await replacement(requestValue, "URL", existing?.url);
    draft.headers = existing?.headers || {};
    const headerAction = await requestValue("Headers", ["Keep or skip", "Replace"]);
    if (headerAction === "Replace") draft.headers = await optionalPairs(requestValue, "Headers");
  }
  const definition = validateMcpServerDraft(draft, manager.workspace, configured);
  saveManagedMcpServer(manager, id, definition);
  return { id, enabled: definition.enabled };
}

function catalogText(kind, groups) {
  const lines = [`# MCP ${kind[0].toUpperCase()}${kind.slice(1)}`];
  if (groups.length === 0) lines.push(`\nNo ${kind} discovered.`);
  for (const group of groups) {
    lines.push(`\n**${group.server}**`);
    if (group.items.length === 0) lines.push(`No ${kind} discovered.`);
    for (const item of group.items) {
      const identity = kind === "resources" ? item.uri : item.name;
      lines.push(`- ${identity || "Unnamed"}${item.description ? ` — ${item.description}` : ""}`);
    }
  }
  return lines.join("\n");
}

async function showCatalog(context, kind, id, interactive = false) {
  const groups = await mcpCatalog(context.manager, kind, id);
  if (interactive) {
    const options = groups.flatMap(group => group.items.map(item => {
      const identity = kind === "resources" ? item.uri : item.name;
      return `${group.server} · ${identity}${item.description ? ` — ${item.description}` : ""}`;
    }));
    await context.requestValue(
      `MCP ${kind}`,
      options.length ? options : [`No ${kind} discovered`],
      { kind: "mcp" },
    );
    return;
  }
  context.respond("answer", catalogText(kind, groups));
}

async function applyOperation(context, action, server) {
  const { manager } = context;
  if (action === "connect") await context.syncTools(await connectMcpServer(manager, server));
  else if (action === "disconnect") await context.syncTools(await disconnectMcpServer(manager, server));
  else if (action === "enable") await context.syncTools(await setMcpServerEnabled(manager, server, true));
  else if (action === "disable") await context.syncTools(await setMcpServerEnabled(manager, server, false));
  else throw new Error(`Unknown MCP action "${action}".`);
  context.respond("answer", `MCP server "${server}" ${action === "enable" ? "enabled" : action === "disable" ? "disabled" : `${action}ed`}.`);
}

async function removeServer(context, server) {
  const confirmed = await context.requestValue(
    `Remove MCP server \`${server}\`?`,
    ["Cancel", "Remove"],
    { kind: "mcp" },
  );
  if (confirmed !== "Remove") return;
  await context.syncTools(await removeManagedMcpServer(context.manager, server));
  context.respond("answer", `MCP server "${server}" removed.`);
}

async function interactiveManager(context) {
  const servers = serverList(context.manager);
  const values = servers.map(server => ({
    label: `${server.id} · ${stateLabel(server.state)} · ${server.tools} tools`,
    value: server.id,
  }));
  const server = await context.requestValue("MCP Servers", values.map(item => item.label), {
    values,
    kind: "mcp",
  });
  if (!server) return;
  const status = statusFor(context.manager, server);
  const allowed = ACTIONS.filter(action => {
    if (action === "Connect") return status.state !== "connected";
    if (action === "Disconnect") return status.state === "connected";
    if (action === "Enable") return !status.enabled;
    if (action === "Disable") return status.enabled;
    return true;
  });
  const action = await context.requestValue(`MCP Server · ${server}`, allowed, { kind: "mcp" });
  if (!action) return;
  if (action.startsWith("Show ")) return showCatalog(context, action.slice(5).toLowerCase(), server, true);
  if (action === "Edit configuration") {
    const result = await serverWizard(context, server);
    if (result) {
      await context.syncTools(await context.manager.refresh());
      context.respond("answer", `MCP server "${server}" updated.`);
    }
    return;
  }
  if (action === "Remove server") return removeServer(context, server);
  return applyOperation(context, action.toLowerCase(), server);
}

export async function manageMcpCommand(argument, context) {
  try {
    const [action = "", server] = String(argument || "").trim().split(/\s+/, 2);
    if (!action) return interactiveManager(context);
    if (action === "list") return context.respond("answer", listText(context.manager));
    if (action === "status") return context.respond("answer", statusText(context.manager, server));
    if (action === "reload" || action === "refresh") {
      await context.syncTools(await context.manager.refresh());
      return context.respond("answer", "MCP configuration reloaded.");
    }
    if (action === "add") {
      const result = await serverWizard(context);
      if (!result) return;
      await context.syncTools(await context.manager.refresh());
      return context.respond("answer", `MCP server "${result.id}" added.`);
    }
    if (action === "remove") {
      if (!server) throw new Error("Usage: /mcp remove <server>");
      return removeServer(context, server);
    }
    if (["connect", "disconnect", "enable", "disable"].includes(action)) {
      if (!server) throw new Error(`Usage: /mcp ${action} <server>`);
      return applyOperation(context, action, server);
    }
    if (["tools", "resources", "prompts"].includes(action)) {
      return showCatalog(context, action, server);
    }
    if (action === "auth") {
      if (!server) throw new Error("Usage: /mcp auth <server>");
      const configured = configuredMcpServers(context.manager.workspace).find(item => item.id === server)?.value;
      if (!configured) throw new Error(`MCP server "${server}" is not configured.`);
      if (!configured.url && configured.type !== "http" && configured.transport !== "http") {
        throw new Error("Stored MCP credentials are only supported for HTTP servers.");
      }
      const credential = await context.requestValue(`Credential for MCP server ${server}`, [], { secret: true });
      if (!credential) return;
      saveCredential(`mcp:${server}`, credential);
      await context.syncTools(await context.manager.refresh());
      return context.respond("answer", `Credential saved for MCP server "${server}".`);
    }
    if (action === "logout") {
      if (!server || !getCredential(`mcp:${server}`)) throw new Error(`No credential is stored for MCP server "${server || ""}".`);
      removeCredential(`mcp:${server}`);
      await context.syncTools(await context.manager.refresh());
      return context.respond("answer", `Credential removed for MCP server "${server}".`);
    }
    throw new Error("Usage: /mcp [list|add|remove|status|connect|disconnect|enable|disable|tools|resources|prompts|reload]");
  } catch (error) {
    context.respond("error", redactSecrets(error?.message || error));
  }
}
