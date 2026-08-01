import { accessSync, constants, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { delimiter, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { loadConfig } from "../config/index.js";

const REQUEST_TIMEOUT_MS = 10_000;
const DIAGNOSTIC_WAIT_MS = 1_500;

const PRESETS = {
  typescript: {
    candidates: [["typescript-language-server", "--stdio"]],
    extensions: [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"],
  },
  python: {
    candidates: [
      ["basedpyright-langserver", "--stdio"],
      ["pyright-langserver", "--stdio"],
      ["pylsp"],
    ],
    extensions: [".py", ".pyi"],
  },
};

function executablePath(command, env = process.env) {
  if (!command) return null;
  if (isAbsolute(command)) {
    try { accessSync(command, constants.X_OK); return command; } catch { return null; }
  }
  const suffixes = process.platform === "win32"
    ? String(env.PATHEXT || ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const directory of String(env.PATH || "").split(delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = resolve(directory, `${command}${suffix}`);
      try { accessSync(candidate, constants.X_OK); return candidate; } catch {}
    }
  }
  return null;
}

function normalizeExtensions(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map(extension => String(extension).toLowerCase())
    .filter(Boolean)
    .map(extension => extension.startsWith(".") ? extension : `.${extension}`))];
}

function presetDefinition(id, override = {}) {
  const preset = PRESETS[id];
  const env = { ...process.env, ...(override.env || {}) };
  const configured = Array.isArray(override.command) && override.command.length
    ? override.command.map(String)
    : null;
  const candidates = configured ? [configured] : preset.candidates;
  const command = candidates.find(candidate => executablePath(candidate[0], env)) || candidates[0];
  return {
    id,
    command,
    available: Boolean(executablePath(command[0], env)),
    extensions: normalizeExtensions(override.extensions || preset.extensions),
    env: override.env || {},
    initialization: override.initialization || {},
  };
}

export function resolveLspDefinitions(workspace, config = loadConfig(workspace)) {
  const value = config.lsp;
  if (!value) return [];
  const overrides = value === true ? {} : value;
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return [];
  const definitions = [];
  for (const id of Object.keys(PRESETS)) {
    const override = overrides[id] || {};
    if (override.disabled) continue;
    definitions.push(presetDefinition(id, override));
  }
  for (const [id, definition] of Object.entries(overrides)) {
    if (Object.hasOwn(PRESETS, id) || definition?.disabled) continue;
    if (!definition || !Array.isArray(definition.command) || !definition.command.length) continue;
    const env = { ...process.env, ...(definition.env || {}) };
    definitions.push({
      id,
      command: definition.command.map(String),
      available: Boolean(executablePath(String(definition.command[0]), env)),
      extensions: normalizeExtensions(definition.extensions),
      env: definition.env || {},
      initialization: definition.initialization || {},
    });
  }
  return definitions.filter(definition => definition.extensions.length > 0);
}

function timeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function insideWorkspace(path, workspace) {
  const value = relative(workspace, path);
  return value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function languageId(path) {
  const extension = extname(path).toLowerCase();
  return {
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".py": "python",
    ".pyi": "python",
  }[extension] || extension.slice(1) || "plaintext";
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function endPosition(text) {
  const lines = String(text).split("\n");
  return { line: lines.length - 1, character: lines.at(-1).length };
}

export function workspaceLocation(uri, range, workspace) {
  let path;
  try { path = fileURLToPath(uri); } catch { return null; }
  if (!insideWorkspace(path, workspace)) return null;
  const start = range?.start || { line: 0, character: 0 };
  return {
    path: relative(workspace, path) || ".",
    line: Number(start.line || 0) + 1,
    character: Number(start.character || 0) + 1,
  };
}

export function flattenSymbols(items, workspace, fallbackUri, output = []) {
  for (const item of items || []) {
    const location = item.location
      ? workspaceLocation(item.location.uri, item.location.range, workspace)
      : workspaceLocation(fallbackUri, item.range || item.selectionRange, workspace);
    output.push({
      name: String(item.name || ""),
      kind: Number(item.kind || 0),
      container: String(item.containerName || ""),
      ...(location || {}),
    });
    if (Array.isArray(item.children)) flattenSymbols(item.children, workspace, fallbackUri, output);
  }
  return output;
}

export function hoverText(contents) {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(hoverText).filter(Boolean).join("\n");
  if (contents && typeof contents === "object") return String(contents.value || "");
  return "";
}

export function diagnosticText(diagnostics, workspace, uri) {
  const path = (() => {
    try { return relative(workspace, fileURLToPath(uri)) || "."; } catch { return "."; }
  })();
  if (!diagnostics?.length) return "LSP diagnostics:\n- No issues reported.";
  const severity = { 1: "error", 2: "warning", 3: "information", 4: "hint" };
  return [
    "LSP diagnostics:",
    ...diagnostics.slice(0, 100).map(item => {
      const start = item.range?.start || { line: 0, character: 0 };
      return `- ${path}:${Number(start.line || 0) + 1}:${Number(start.character || 0) + 1} [${severity[item.severity] || "diagnostic"}] ${String(item.message || "").replace(/\s+/g, " ").trim()}`;
    }),
  ].join("\n");
}

export class LspServer {
  constructor(workspace, definition, options = {}) {
    this.workspace = workspace;
    this.definition = definition;
    this.process = null;
    this.connection = null;
    this.capabilities = {};
    this.documents = new Map();
    this.diagnostics = new Map();
    this.diagnosticWaiters = new Map();
    this.stderr = "";
    this.state = definition.available ? "idle" : "unavailable";
    this.exitPromise = Promise.resolve();
    this.requestTimeoutMs = options.requestTimeoutMs || REQUEST_TIMEOUT_MS;
    this.diagnosticWaitMs = options.diagnosticWaitMs || DIAGNOSTIC_WAIT_MS;
  }

  async start() {
    if (this.connection && this.process && this.process.exitCode === null) return;
    if (!this.definition.available) {
      throw new Error(`Language server "${this.definition.id}" is not installed or not executable.`);
    }
    const [command, ...args] = this.definition.command;
    this.process = spawn(command, args, {
      cwd: this.workspace,
      env: { ...process.env, ...this.definition.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.state = "starting";
    let resolveExit;
    this.exitPromise = new Promise(resolvePromise => { resolveExit = resolvePromise; });
    this.process.stderr.on("data", chunk => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4000);
    });
    this.process.on("error", error => {
      this.stderr = `${this.stderr}\n${error.message}`.slice(-4000);
      this.state = "stopped";
    });
    this.process.once("exit", (code, signal) => {
      this.state = "stopped";
      this.connection = null;
      resolveExit({ code, signal });
    });
    this.connection = createMessageConnection(
      new StreamMessageReader(this.process.stdout),
      new StreamMessageWriter(this.process.stdin),
    );
    this.connection.onNotification("textDocument/publishDiagnostics", params => {
      this.diagnostics.set(params.uri, params.diagnostics || []);
      const waiters = this.diagnosticWaiters.get(params.uri) || [];
      this.diagnosticWaiters.delete(params.uri);
      for (const resolveWaiter of waiters) resolveWaiter(params.diagnostics || []);
    });
    this.connection.onRequest("workspace/configuration", params =>
      (params?.items || []).map(() => null)
    );
    this.connection.onRequest("workspace/workspaceFolders", () => [
      { uri: pathToFileURL(this.workspace).href, name: "workspace" },
    ]);
    this.connection.listen();
    try {
      const initialize = this.connection.sendRequest("initialize", {
        processId: process.pid,
        clientInfo: { name: "khazai-ai" },
        rootUri: pathToFileURL(this.workspace).href,
        rootPath: this.workspace,
        workspaceFolders: [{ uri: pathToFileURL(this.workspace).href, name: "workspace" }],
        capabilities: {
          workspace: { symbol: {} },
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: true },
            definition: {},
            references: {},
            hover: {},
            documentSymbol: {},
            diagnostic: {},
          },
        },
        initializationOptions: this.definition.initialization,
      });
      const result = await timeout(Promise.race([
        initialize,
        this.exitPromise.then(() => { throw new Error(`Language server "${this.definition.id}" exited during initialization.`); }),
      ]), this.requestTimeoutMs, `Language server "${this.definition.id}" initialization timed out.`);
      this.capabilities = result?.capabilities || {};
      await this.connection.sendNotification("initialized", {});
      this.state = "running";
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async request(method, params) {
    await this.start();
    return timeout(
      Promise.race([
        this.connection.sendRequest(method, params),
        this.exitPromise.then(() => { throw new Error(`Language server "${this.definition.id}" exited during "${method}".`); }),
      ]),
      this.requestTimeoutMs,
      `Language server request "${method}" timed out.`,
    );
  }

  async sync(path) {
    await this.start();
    const source = readFileSync(path, "utf-8");
    const digest = hash(source);
    const uri = pathToFileURL(path).href;
    const existing = this.documents.get(uri);
    if (!existing) {
      this.documents.set(uri, { version: 1, hash: digest, text: source });
      await this.connection.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId: languageId(path), version: 1, text: source },
      });
    } else if (existing.hash !== digest) {
      const version = existing.version + 1;
      this.documents.set(uri, { version, hash: digest, text: source });
      this.diagnostics.delete(uri);
      const synchronization = this.capabilities.textDocumentSync;
      const changeKind = typeof synchronization === "number"
        ? synchronization
        : synchronization?.change;
      const contentChanges = changeKind === 2
        ? [{
            range: { start: { line: 0, character: 0 }, end: endPosition(existing.text) },
            text: source,
          }]
        : [{ text: source }];
      await this.connection.sendNotification("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges,
      });
      await this.connection.sendNotification("textDocument/didSave", {
        textDocument: { uri },
      });
    }
    return uri;
  }

  waitForDiagnostics(uri) {
    if (this.diagnostics.has(uri)) return Promise.resolve(this.diagnostics.get(uri));
    return new Promise(resolveWaiter => {
      const waiters = this.diagnosticWaiters.get(uri) || [];
      waiters.push(resolveWaiter);
      this.diagnosticWaiters.set(uri, waiters);
      setTimeout(() => {
        const active = this.diagnosticWaiters.get(uri) || [];
        const index = active.indexOf(resolveWaiter);
        if (index !== -1) active.splice(index, 1);
        if (active.length) this.diagnosticWaiters.set(uri, active);
        else this.diagnosticWaiters.delete(uri);
        resolveWaiter(this.diagnostics.get(uri) || []);
      }, this.diagnosticWaitMs);
    });
  }

  async stop() {
    const connection = this.connection;
    const child = this.process;
    this.connection = null;
    this.process = null;
    this.state = "stopped";
    if (connection) {
      for (const uri of this.documents.keys()) {
        try { await connection.sendNotification("textDocument/didClose", { textDocument: { uri } }); } catch {}
      }
      try { await timeout(connection.sendRequest("shutdown"), 1_000, "shutdown timeout"); } catch {}
      try { await connection.sendNotification("exit"); } catch {}
      try { connection.dispose(); } catch {}
    }
    this.documents.clear();
    this.diagnostics.clear();
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      const exited = new Promise(resolveExit => child.once("exit", resolveExit));
      await Promise.race([exited, new Promise(resolveWait => setTimeout(resolveWait, 500))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }

  kill() {
    if (this.process?.exitCode === null) this.process.kill("SIGTERM");
  }

  status() {
    return {
      id: this.definition.id,
      command: this.definition.command,
      extensions: this.definition.extensions,
      available: this.definition.available,
      state: this.state,
      pid: this.process?.pid || null,
      error: this.stderr.trim().slice(-500),
    };
  }
}
