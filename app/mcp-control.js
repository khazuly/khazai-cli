import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { loadConfig, removeMcpServer, saveMcpServer } from "../config/index.js";
import { redactSecrets } from "../lib/secrets.js";

function connectionFor(manager, id) {
  const connection = manager.connections.find(item => item.definition.id === id);
  if (!connection) throw new Error(`MCP server "${id}" is not configured.`);
  return connection;
}

function executablePath(command, workspace) {
  const candidates = isAbsolute(command) || command.includes("/")
    ? [resolve(workspace, command)]
    : String(process.env.PATH || "").split(delimiter).filter(Boolean).map(path => resolve(path, command));
  return candidates.find(path => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function pairs(value, label) {
  const result = {};
  if (!String(value || "").trim()) return result;
  for (const entry of String(value).split(",").map(item => item.trim()).filter(Boolean)) {
    const separator = entry.indexOf("=");
    if (separator <= 0) throw new Error(`${label} must use NAME=value entries separated by commas.`);
    const name = entry.slice(0, separator).trim();
    const itemValue = entry.slice(separator + 1).trim();
    if (!name || !itemValue) throw new Error(`${label} entries require both a name and value.`);
    result[name] = itemValue;
  }
  return result;
}

export function validateMcpServerDraft(draft, workspace, configured = {}) {
  const id = String(draft.id || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
    throw new Error("MCP server names may contain only letters, numbers, hyphens, and underscores.");
  }
  if (!draft.editing && configured[id] !== undefined && configured[id] !== null) {
    throw new Error(`MCP server "${id}" is already configured.`);
  }
  const transport = String(draft.transport || "").toLowerCase();
  if (!["stdio", "http"].includes(transport)) throw new Error("MCP transport must be stdio or http.");
  const enabled = draft.enabled !== false;
  if (transport === "stdio") {
    const command = String(draft.command || "").trim();
    if (!command) throw new Error("A stdio MCP server requires a command.");
    if (!executablePath(command, workspace)) throw new Error(`Executable "${command}" was not found.`);
    return {
      type: "stdio",
      command,
      args: Array.isArray(draft.args) ? draft.args : [],
      env: draft.env || {},
      enabled,
    };
  }
  let url;
  try { url = new URL(String(draft.url || "")); } catch { throw new Error("MCP server URL is invalid."); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("MCP server URL must use HTTP or HTTPS.");
  if (url.username || url.password) throw new Error("MCP server URLs cannot contain credentials.");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (!loopback && url.protocol !== "https:") throw new Error("Remote MCP servers must use HTTPS.");
  return { type: "http", url: url.toString(), headers: draft.headers || {}, enabled };
}

export function parseMcpPairs(value, label) {
  return pairs(value, label);
}

export async function connectMcpServer(manager, id) {
  const connection = connectionFor(manager, id);
  if (connection.state === "connected") return manager.tools();
  await connection.discover(true);
  if (connection.state !== "connected") throw new Error(connection.error || `MCP server "${id}" did not connect.`);
  return manager.rebuildTools();
}

export async function disconnectMcpServer(manager, id) {
  const connection = connectionFor(manager, id);
  await connection.close();
  connection.state = connection.definition.enabled ? "disconnected" : "disabled";
  return manager.rebuildTools();
}

export async function setMcpServerEnabled(manager, id, enabled) {
  const config = loadConfig(manager.workspace);
  const current = config.mcp?.[id];
  if (!current) throw new Error(`MCP server "${id}" is not configured.`);
  saveMcpServer(id, { ...current, enabled }, join(manager.workspace, ".khazai-ai.json"));
  await manager.refresh();
  return manager.tools();
}

export async function removeManagedMcpServer(manager, id) {
  if (manager.connections.some(item => item.definition.id === id)) {
    await disconnectMcpServer(manager, id);
  }
  removeMcpServer(id, join(manager.workspace, ".khazai-ai.json"));
  await manager.refresh();
  return manager.tools();
}

export function saveManagedMcpServer(manager, id, definition) {
  saveMcpServer(id, definition, join(manager.workspace, ".khazai-ai.json"));
}

async function listPaged(connection, kind) {
  if (connection.state !== "connected" || !connection.client) {
    throw new Error(`MCP server "${connection.definition.id}" is not connected.`);
  }
  const values = [];
  let cursor;
  do {
    const result = kind === "resources"
      ? await connection.client.listResources(cursor ? { cursor } : undefined)
      : await connection.client.listPrompts(cursor ? { cursor } : undefined);
    values.push(...(result[kind] || []));
    cursor = result.nextCursor;
  } while (cursor);
  connection[kind] = values;
  return values;
}

export async function mcpCatalog(manager, kind, id) {
  const connections = id
    ? [connectionFor(manager, id)]
    : kind === "tools"
      ? manager.connections
      : manager.connections.filter(connection => connection.state === "connected");
  const output = [];
  for (const connection of connections) {
    const values = kind === "tools"
      ? connection.tools
      : await listPaged(connection, kind);
    output.push({
      server: connection.definition.id,
      items: values.map(item => ({
        name: redactSecrets(item.name || ""),
        description: redactSecrets(item.description || ""),
        uri: redactSecrets(item.uri || item.uriTemplate || ""),
      })),
    });
  }
  return output;
}

export function configuredMcpServers(workspace) {
  return Object.entries(loadConfig(workspace).mcp || {})
    .filter(([, value]) => value !== null && value?.removed !== true)
    .map(([id, value]) => ({ id, value }));
}
