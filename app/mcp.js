import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../config/index.js";
import { getCredential } from "../lib/auth.js";
import { redactSecrets } from "../lib/secrets.js";

const OUTPUT_LIMIT = 100 * 1024;
const DEFAULT_DISCOVERY_TIMEOUT = 5_000;
const DEFAULT_CALL_TIMEOUT = 60_000;
const managers = new Map();

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function wildcard(pattern, value) {
  const expression = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${expression}$`, "i").test(String(value));
}

function cleanError(error, secrets = []) {
  let message = redactSecrets(error?.message || error || "Unknown MCP error.");
  for (const secret of secrets.filter(Boolean)) message = message.split(secret).join("[REDACTED]");
  return message.replace(/\s+/g, " ").trim();
}

function expand(value, auth, secrets) {
  return String(value).replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}|\{auth\}/g, (match, name) => {
    const replacement = name ? process.env[name] : auth;
    if (!replacement) throw new Error(name
      ? `Environment variable ${name} is required by the MCP configuration.`
      : "This MCP server requires a stored credential.");
    secrets.add(replacement);
    return replacement;
  });
}

function sensitiveName(name) {
  return /authorization|api[-_]?key|token|secret|password|credential|cookie/i.test(String(name));
}

function insideWorkspace(path, workspace) {
  const result = relative(resolve(workspace), resolve(path));
  return result === "" || (!result.startsWith("..") && !isAbsolute(result));
}

function isLoopback(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function validateRemoteUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("MCP server URL is invalid."); }
  if (url.username || url.password) throw new Error("MCP server URLs cannot contain credentials.");
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("MCP server URL must use HTTP or HTTPS.");
  if (!isLoopback(url.hostname) && url.protocol !== "https:") {
    throw new Error("Remote MCP servers must use HTTPS.");
  }
  return url;
}

async function safeFetch(input, init = {}) {
  let url = validateRemoteUrl(typeof input === "string" || input instanceof URL ? input : input.url);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(url, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    url = validateRemoteUrl(new URL(location, url));
  }
  throw new Error("MCP server redirected too many times.");
}

function normalizeDefinition(id, value, workspace) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new Error(`Invalid MCP server ID "${id}".`);
  const entry = object(value);
  const auth = getCredential(`mcp:${id}`, entry.authEnv);
  const secrets = new Set(auth ? [auth] : []);
  const enabled = entry.enabled !== false;
  const discoveryTimeout = Math.max(250, Number(entry.discoveryTimeout) || DEFAULT_DISCOVERY_TIMEOUT);
  const callTimeout = Math.max(250, Number(entry.callTimeout) || DEFAULT_CALL_TIMEOUT);
  const common = {
    id, enabled, discoveryTimeout, callTimeout, secrets,
    authEnv: entry.authEnv,
    tools: object(entry.tools),
  };

  if (entry.url || entry.type === "http" || entry.transport === "http") {
    const url = validateRemoteUrl(expand(entry.url || "", auth, secrets));
    for (const [name, value] of url.searchParams) {
      if (sensitiveName(name) && value) secrets.add(value);
    }
    const headers = {};
    for (const [name, header] of Object.entries(object(entry.headers))) {
      if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) throw new Error(`Invalid header name for MCP server "${id}".`);
      headers[name] = expand(header, auth, secrets);
      if (sensitiveName(name) && headers[name]) secrets.add(headers[name]);
    }
    return { ...common, type: "http", url, headers };
  }

  if (!entry.command || typeof entry.command !== "string") {
    throw new Error(`MCP server "${id}" requires a command or URL.`);
  }
  const cwd = resolve(workspace, entry.cwd || ".");
  if (!insideWorkspace(cwd, workspace)) throw new Error(`MCP server "${id}" workdir must be inside the workspace.`);
  const env = {};
  for (const [name, envValue] of Object.entries(object(entry.env))) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid environment name for MCP server "${id}".`);
    env[name] = expand(envValue, auth, secrets);
    if (sensitiveName(name) && env[name]) secrets.add(env[name]);
  }
  return {
    ...common,
    type: "stdio",
    command: expand(entry.command, auth, secrets),
    args: Array.isArray(entry.args) ? entry.args.map(arg => expand(arg, auth, secrets)) : [],
    cwd,
    env,
  };
}

export function resolveMcpDefinitions(workspace, config = loadConfig(workspace)) {
  const definitions = [];
  const errors = [];
  for (const [id, value] of Object.entries(object(config.mcp))) {
    try { definitions.push(normalizeDefinition(id, value, workspace)); }
    catch (error) { errors.push({ id, type: value?.url ? "http" : "stdio", state: "error", toolCount: 0, error: cleanError(error) }); }
  }
  return { definitions, errors };
}

function toolEnabled(definition, name) {
  let enabled = true;
  for (const [pattern, value] of Object.entries(definition.tools)) {
    if (wildcard(pattern, name)) enabled = value !== false;
  }
  return enabled;
}

function nativeToolName(server, tool) {
  const raw = `mcp_${server}_${tool}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
  if (raw.length <= 64) return raw;
  const hash = createHash("sha256").update(`${server}:${tool}`).digest("hex").slice(0, 8);
  return `${raw.slice(0, 55)}_${hash}`;
}

function byteLength(value) {
  if (typeof value !== "string") return 0;
  try { return Buffer.byteLength(value, "base64"); } catch { return value.length; }
}

function resultPart(part) {
  if (!part || typeof part !== "object") return String(part ?? "");
  if (part.type === "text") return part.text || "";
  if (part.type === "image") return `[Image: ${part.mimeType || "unknown type"}, ${byteLength(part.data)} bytes]`;
  if (part.type === "audio") return `[Audio: ${part.mimeType || "unknown type"}, ${byteLength(part.data)} bytes]`;
  if (part.type === "resource") {
    const resource = object(part.resource);
    if (typeof resource.text === "string") return `[Resource: ${resource.uri || "unknown"}]\n${resource.text}`;
    return `[Resource: ${resource.uri || "unknown"}, ${resource.mimeType || "unknown type"}, ${byteLength(resource.blob)} bytes]`;
  }
  if (part.type === "resource_link") return `[Resource link: ${part.name || part.uri || "unknown"} — ${part.uri || ""}]`;
  return JSON.stringify(part);
}

export function normalizeMcpResult(result, secrets = []) {
  const lines = Array.isArray(result?.content) ? result.content.map(resultPart) : [];
  if (result?.structuredContent !== undefined) {
    lines.push(JSON.stringify(result.structuredContent, null, 2));
  }
  let output = redactSecrets(lines.filter(Boolean).join("\n"));
  for (const secret of secrets.filter(Boolean)) output = output.split(secret).join("[REDACTED]");
  if (result?.isError) output = `Error: MCP tool failed${output ? `: ${output}` : "."}`;
  if (!output) output = result?.isError ? "Error: MCP tool failed." : "MCP tool completed without output.";
  const buffer = Buffer.from(output);
  if (buffer.length > OUTPUT_LIMIT) {
    output = `${buffer.subarray(0, OUTPUT_LIMIT).toString("utf-8")}\n[Output truncated at 100 KiB]`;
  }
  return output;
}

class McpConnection {
  constructor(definition) {
    this.definition = definition;
    this.state = definition.enabled ? "idle" : "disabled";
    this.error = "";
    this.tools = [];
    this.client = null;
    this.transport = null;
    this.stderr = "";
  }

  createTransport() {
    if (this.definition.type === "stdio") {
      const transport = new StdioClientTransport({
        command: this.definition.command,
        args: this.definition.args,
        cwd: this.definition.cwd,
        env: { ...getDefaultEnvironment(), ...this.definition.env },
        stderr: "pipe",
      });
      transport.stderr?.on("data", chunk => {
        this.stderr = cleanError(`${this.stderr}${chunk}`, [...this.definition.secrets]).slice(-8192);
      });
      return transport;
    }
    return new StreamableHTTPClientTransport(this.definition.url, {
      requestInit: { headers: this.definition.headers },
      fetch: safeFetch,
      reconnectionOptions: {
        maxReconnectionDelay: 1_000,
        initialReconnectionDelay: 250,
        reconnectionDelayGrowFactor: 1,
        maxRetries: 0,
      },
    });
  }

  async open() {
    this.state = "connecting";
    this.transport = this.createTransport();
    this.client = new Client({ name: "khazai-ai", version: "0.3.0" }, { capabilities: {} });
    await this.client.connect(this.transport, { timeout: this.definition.discoveryTimeout });
  }

  async discover() {
    if (!this.definition.enabled) return [];
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.open();
        const tools = [];
        let cursor;
        do {
          const result = await this.client.listTools(cursor ? { cursor } : undefined, {
            timeout: this.definition.discoveryTimeout,
          });
          tools.push(...result.tools);
          cursor = result.nextCursor;
        } while (cursor);
        this.tools = tools.filter(tool => toolEnabled(this.definition, tool.name));
        this.state = "connected";
        this.error = "";
        return this.tools;
      } catch (error) {
        lastError = error;
        await this.close();
      }
    }
    this.state = "error";
    this.error = cleanError(lastError, [...this.definition.secrets]);
    return [];
  }

  async call(name, args) {
    if (this.state !== "connected" || !this.client) return "Error: MCP server is not connected. Run /mcp refresh.";
    try {
      const result = await this.client.callTool(
        { name, arguments: object(args) },
        undefined,
        { timeout: this.definition.callTimeout },
      );
      return normalizeMcpResult(result, [...this.definition.secrets]);
    } catch (error) {
      this.error = cleanError(error, [...this.definition.secrets]);
      this.state = "error";
      await this.close();
      return `Error: MCP tool call failed: ${this.error}`;
    }
  }

  status() {
    return {
      id: this.definition.id,
      type: this.definition.type,
      state: this.state,
      toolCount: this.tools.length,
      pid: this.transport?.pid || undefined,
      error: this.error || undefined,
      authConfigured: Boolean(getCredential(`mcp:${this.definition.id}`, this.definition.authEnv)),
    };
  }

  async close() {
    const transport = this.transport;
    const client = this.client;
    this.client = null;
    this.transport = null;
    try {
      if (transport?.sessionId) await transport.terminateSession();
    } catch {}
    try { await client?.close(); } catch {}
    try { await transport?.close(); } catch {}
    if (this.state !== "error") this.state = this.definition.enabled ? "idle" : "disabled";
  }
}

export class McpManager {
  constructor(workspace, config = null) {
    this.workspace = resolve(workspace);
    this.config = config;
    this.reloadConfig = config === null;
    this.connections = [];
    this.invalid = [];
    this.nativeTools = [];
  }

  async refresh() {
    await this.shutdown();
    if (this.reloadConfig) this.config = loadConfig(this.workspace);
    const { definitions, errors } = resolveMcpDefinitions(this.workspace, this.config);
    this.invalid = errors;
    this.connections = definitions.map(definition => new McpConnection(definition));
    await Promise.all(this.connections.map(connection => connection.discover()));

    const used = new Map();
    const wrappers = [];
    for (const connection of this.connections) {
      for (const tool of connection.tools) {
        let name = nativeToolName(connection.definition.id, tool.name);
        const identity = `${connection.definition.id}:${tool.name}`;
        if (used.has(name) && used.get(name) !== identity) {
          const hash = createHash("sha256").update(identity).digest("hex").slice(0, 8);
          name = `${name.slice(0, 55)}_${hash}`;
        }
        used.set(name, identity);
        wrappers.push({
          name,
          description: `[MCP ${connection.definition.id}/${tool.name}] ${tool.description || "External MCP tool."}`,
          parameters: tool.inputSchema || { type: "object", properties: {} },
          execute: args => connection.call(tool.name, args),
          mcp: { server: connection.definition.id, tool: tool.name },
        });
      }
    }
    this.nativeTools = wrappers;
    return wrappers;
  }

  tools() { return [...this.nativeTools]; }
  status() { return [...this.invalid, ...this.connections.map(connection => connection.status())]; }

  async shutdown() {
    await Promise.all(this.connections.map(connection => connection.close()));
    this.connections = [];
    this.nativeTools = [];
  }
}

export function getMcpManager(workspace) {
  const key = resolve(workspace);
  if (!managers.has(key)) managers.set(key, new McpManager(key));
  return managers.get(key);
}

export function mcpStatus(workspace) {
  return getMcpManager(workspace).status();
}

export async function shutdownAllMcp() {
  await Promise.all([...managers.values()].map(manager => manager.shutdown()));
  managers.clear();
}

function killMcpProcesses() {
  for (const manager of managers.values()) {
    for (const connection of manager.connections) {
      const pid = connection.transport?.pid;
      if (pid) {
        try { process.kill(pid, "SIGTERM"); } catch {}
      }
    }
  }
}

process.once("exit", killMcpProcesses);
