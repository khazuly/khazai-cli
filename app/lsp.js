import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import { loadConfig } from "../config/index.js";
import {
  LspServer,
  diagnosticText,
  flattenSymbols,
  hoverText,
  insideWorkspace,
  resolveLspDefinitions,
  workspaceLocation,
} from "./lsp-client.js";

export class LspManager {
  constructor(workspace, config = loadConfig(workspace), options = {}) {
    this.workspace = resolve(workspace);
    this.definitions = resolveLspDefinitions(this.workspace, config);
    this.servers = new Map();
    this.options = options;
    this.signature = JSON.stringify(this.definitions);
  }

  enabled() {
    return this.definitions.length > 0;
  }

  definitionFor(path) {
    const extension = extname(path).toLowerCase();
    return this.definitions.find(definition => definition.extensions.includes(extension)) || null;
  }

  serverFor(definition) {
    if (!this.servers.has(definition.id)) {
      this.servers.set(definition.id, new LspServer(this.workspace, definition, this.options));
    }
    return this.servers.get(definition.id);
  }

  resolveFile(path) {
    const absolute = resolve(this.workspace, String(path || ""));
    if (!insideWorkspace(absolute, this.workspace)) throw new Error("LSP file is outside the workspace.");
    if (!existsSync(absolute)) throw new Error(`LSP file was not found: ${path}`);
    return absolute;
  }

  async withServer(path, action, { retry = true } = {}) {
    const absolute = this.resolveFile(path);
    const definition = this.definitionFor(absolute);
    if (!definition) throw new Error(`No language server is configured for ${extname(absolute) || "this file type"}.`);
    if (!definition.available) throw new Error(`Language server "${definition.id}" is not installed or not executable.`);
    let server = this.serverFor(definition);
    try {
      return await action(server, absolute);
    } catch (error) {
      if (!retry) throw error;
      await server.stop();
      this.servers.delete(definition.id);
      server = this.serverFor(definition);
      return action(server, absolute);
    }
  }

  async diagnostics(path, { silentUnavailable = false } = {}) {
    try {
      return await this.withServer(path, async (server, absolute) => {
        const uri = await server.sync(absolute);
        let diagnostics;
        if (server.capabilities.diagnosticProvider) {
          const report = await server.request("textDocument/diagnostic", {
            textDocument: { uri },
          });
          diagnostics = report?.items || [];
        } else {
          diagnostics = await server.waitForDiagnostics(uri);
        }
        return diagnosticText(diagnostics, this.workspace, uri);
      });
    } catch (error) {
      if (silentUnavailable) return null;
      return `LSP error: ${error.message}`;
    }
  }

  async query({ operation, path, line = 1, character = 1, query = "" }) {
    if (operation === "workspaceSymbol") {
      const definitions = this.definitions.filter(item => item.available);
      if (!definitions.length) return "LSP error: No configured language server is available.";
      const results = await Promise.all(definitions.map(async definition => {
        try {
          const server = this.serverFor(definition);
          const result = await server.request("workspace/symbol", { query: String(query || "") });
          return flattenSymbols(result, this.workspace, "");
        } catch {
          return [];
        }
      }));
      return formatSymbols(results.flat());
    }
    if (operation === "diagnostics") return this.diagnostics(path);
    try {
      return await this.withServer(path, async (server, absolute) => {
        const uri = await server.sync(absolute);
        const position = {
          line: Math.max(0, Number(line || 1) - 1),
          character: Math.max(0, Number(character || 1) - 1),
        };
        if (operation === "hover") {
          const result = await server.request("textDocument/hover", { textDocument: { uri }, position });
          const text = hoverText(result?.contents).trim();
          return text ? `LSP hover:\n${text}` : "LSP hover: no information.";
        }
        if (operation === "documentSymbol") {
          const result = await server.request("textDocument/documentSymbol", { textDocument: { uri } });
          return formatSymbols(flattenSymbols(result, this.workspace, uri));
        }
        const methods = {
          goToDefinition: "textDocument/definition",
          findReferences: "textDocument/references",
        };
        const method = methods[operation];
        if (!method) return `LSP error: Unsupported operation "${operation}".`;
        const params = {
          textDocument: { uri },
          position,
          ...(operation === "findReferences" ? { context: { includeDeclaration: true } } : {}),
        };
        const result = await server.request(method, params);
        const values = Array.isArray(result) ? result : result ? [result] : [];
        const locations = values.map(item => item.targetUri
          ? workspaceLocation(item.targetUri, item.targetSelectionRange || item.targetRange, this.workspace)
          : workspaceLocation(item.uri, item.range, this.workspace)
        ).filter(Boolean);
        return locations.length
          ? ["LSP locations:", ...locations.map(item => `- ${item.path}:${item.line}:${item.character}`)].join("\n")
          : "LSP locations: none.";
      });
    } catch (error) {
      return `LSP error: ${error.message}`;
    }
  }

  status() {
    return this.definitions.map(definition => {
      const server = this.servers.get(definition.id);
      return server?.status() || {
        id: definition.id,
        command: definition.command,
        extensions: definition.extensions,
        available: definition.available,
        state: definition.available ? "idle" : "unavailable",
        pid: null,
        error: "",
      };
    });
  }

  async shutdown() {
    await Promise.all([...this.servers.values()].map(server => server.stop()));
    this.servers.clear();
  }

  kill() {
    for (const server of this.servers.values()) server.kill();
  }
}

function formatSymbols(symbols) {
  if (!symbols.length) return "LSP symbols: none.";
  return [
    "LSP symbols:",
    ...symbols.slice(0, 100).map(item =>
      `- ${item.name}${item.container ? ` (${item.container})` : ""}${item.path ? ` — ${item.path}:${item.line}:${item.character}` : ""}`
    ),
  ].join("\n");
}

const managers = new Map();
let exitHookInstalled = false;

export function getLspManager(workspace, config = loadConfig(workspace)) {
  const key = resolve(workspace);
  const next = new LspManager(key, config);
  const existing = managers.get(key);
  if (existing && existing.signature !== next.signature) {
    existing.kill();
    managers.set(key, next);
  } else if (!existing) {
    managers.set(key, next);
  }
  if (!exitHookInstalled) {
    process.once("exit", () => {
      for (const manager of managers.values()) manager.kill();
    });
    exitHookInstalled = true;
  }
  return managers.get(key);
}

export async function shutdownAllLsp() {
  await Promise.all([...managers.values()].map(manager => manager.shutdown()));
  managers.clear();
}

export function lspStatus(workspace) {
  const config = loadConfig(workspace);
  if (!config.lsp) {
    const key = resolve(workspace);
    managers.get(key)?.kill();
    managers.delete(key);
    return { enabled: false, servers: [] };
  }
  const manager = getLspManager(workspace, config);
  return { enabled: manager.enabled(), servers: manager.status() };
}

export { resolveLspDefinitions } from "./lsp-client.js";
