import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { redactSecrets, redactSerializable } from "../lib/secrets.js";
import { emitPerformanceTimings, measurePhase } from "./performance-timings.js";
import { canonicalizeSessionModelNames, migrateSessionV6, validateSessionSchema } from "./session-schema.js";
import { canonicalModelKey } from "../config/khazai-free-models.js";
import { captureGitState, createJournal, journalMatches, restoreJournal } from "./session-snapshot.js";
export {
  canonicalizeSessionModelNames,
  migrateSessionV2,
  migrateSessionV3,
  migrateSessionV4,
  migrateSessionV5,
  migrateSessionV6,
} from "./session-schema.js";

const DATA_DIR = join(homedir(), ".local", "share", "khazai-ai", "sessions");

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function workspaceKey(workspace) {
  return hash(resolve(workspace)).slice(0, 24);
}

function safeJSON(value) {
  return redactSerializable(value);
}

function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf-8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export class SessionStore {
  constructor(workspace, root = DATA_DIR) {
    this.workspace = resolve(workspace);
    this.directory = join(root, workspaceKey(this.workspace));
    this._cached = new Map();
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  partsPath(id) {
    return join(this.directory, `${id}.parts.json`);
  }

  _writeParts(id, parts, runtime, activeRun = null) {
    atomicWrite(this.partsPath(id), { version: 2, parts: parts || [], runtime: runtime || null, activeRun });
  }

  _mergeSidecar(data) {
    const partsPath = this.partsPath(data.id);
    if (!existsSync(partsPath)) return data;
    try {
      const sidecar = JSON.parse(readFileSync(partsPath, "utf-8"));
      if (Array.isArray(sidecar.parts)) data.parts = sidecar.parts;
      if (sidecar.runtime) data.runtime = sidecar.runtime;
      if (sidecar.activeRun) data.activeRun = sidecar.activeRun;
      if (data.agentState) {
        data.agentState = {
          ...data.agentState,
          parts: data.parts.slice(-200),
          activeRun: sidecar.activeRun || data.agentState.activeRun || null,
        };
      }
    } catch {}
    return data;
  }

  path(id) {
    return join(this.directory, `${id}.json`);
  }

  create({ title = "New session", model = "auto-free", agent = "build" } = {}) {
    const now = new Date().toISOString();
    const session = {
      version: 6,
      id: randomUUID(),
      workspace: this.workspace,
      title,
      model,
      agent,
      createdAt: now,
      updatedAt: now,
      messages: [],
      agentState: null,
      parts: [],
      turns: [],
      redo: [],
      permissionMode: "prompt",
      runtime: { version: 4, lastPartAt: null },
      activeRun: null,
    };
    this.save(session);
    return session;
  }

  save(session) {
    const next = { ...session, workspace: this.workspace, updatedAt: new Date().toISOString() };
    const parts = Array.isArray(next.parts) ? next.parts : [];
    this._writeParts(next.id, parts.slice(-1_000), next.runtime, next.agentState?.activeRun || next.activeRun);
    atomicWrite(this.path(next.id), next);
    this._cached.set(next.id, next);
    return next;
  }

  load(id) {
    const cached = this._cached.get(id);
    if (cached) {
      if (!Object.prototype.hasOwnProperty.call(cached, "hydrationTimings")) {
        Object.defineProperty(cached, "hydrationTimings", {
          value: { cacheHitMs: 0 },
          enumerable: false,
          configurable: true,
        });
      }
      return cached;
    }
    const timings = {};
    const raw = measurePhase(timings, "sessionFileReadMs", () => readFileSync(this.path(id), "utf-8"));
    const original = measurePhase(timings, "jsonParseMs", () => JSON.parse(raw));
    const data = measurePhase(timings, "schemaMigrationMs", () => canonicalizeSessionModelNames(migrateSessionV6(original)));
    measurePhase(timings, "schemaValidationMs", () => validateSessionSchema(data));
    if (resolve(data.workspace) !== this.workspace) throw new Error("Session belongs to a different workspace.");
    measurePhase(timings, "sidecarMergeMs", () => this._mergeSidecar(data));
    Object.defineProperty(data, "hydrationTimings", { value: timings, enumerable: false, configurable: true });
    this._cached.set(id, data);
    if (original.version !== 6) this.save(data);
    emitPerformanceTimings("session-resume", timings);
    return data;
  }

  updatePart(sessionId, part, activeRun = undefined) {
    if (!sessionId || !part || !existsSync(this.path(sessionId))) return null;
    const session = this._cached.get(sessionId) ?? this.load(sessionId);
    const parts = Array.isArray(session.parts) ? [...session.parts] : [];
    const index = parts.findIndex(item => item.id === part.id);
    if (index === -1) parts.push(safeJSON(part));
    else parts[index] = safeJSON(part);
    session.parts = parts.slice(-1_000);
    session.runtime = {
      version: 4,
      lastPartAt: new Date().toISOString(),
      activeMessageId: part.type === "step-finish" ? null : part.messageId,
    };
    if (activeRun !== undefined) {
      session.activeRun = activeRun;
      if (session.agentState) session.agentState = { ...session.agentState, activeRun };
    }
    if (session.agentState) session.agentState = { ...session.agentState, parts: session.parts.slice(-200) };
    this._writeParts(sessionId, session.parts, session.runtime, session.agentState?.activeRun || session.activeRun);
    this._cached.set(sessionId, session);
    return session;
  }

  list() {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory)
      .filter(name => name.endsWith(".json") && !name.endsWith(".parts.json"))
      .map(name => {
        try { return JSON.parse(readFileSync(join(this.directory, name), "utf-8")); } catch { return null; }
      })
      .filter(session => session?.id && typeof session.workspace === "string" && resolve(session.workspace) === this.workspace)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(({ id, title, model, agent, createdAt, updatedAt, messages }) => ({
        id,
        title,
        model: canonicalModelKey(model),
        agent,
        createdAt,
        updatedAt,
        messageCount: Array.isArray(messages) ? messages.length : 0,
      }));
  }

  fork(id) {
    const source = this.load(id);
    const fork = this.create({
      title: `${source.title} (fork)`,
      model: source.model,
      agent: source.agent,
    });
    fork.messages = source.messages;
    fork.agentState = source.agentState ? { ...source.agentState, activeRun: null } : null;
    fork.parts = source.parts || source.agentState?.parts || [];
    fork.activeRun = null;
    fork.permissionMode = source.permissionMode === "allow-all" ? "allow-all" : "prompt";
    return this.save(fork);
  }

  captureGitState(paths) {
    return captureGitState(this.workspace, paths);
  }

  recordTurn(session, { input, before, after, messages, agentState, agentStateBefore = null }) {
    if (session?.id && existsSync(this.path(session.id))) {
      const persisted = this.load(session.id);
      session = {
        ...persisted,
        ...session,
        parts: persisted.parts,
        runtime: persisted.runtime,
      };
    }
    const journal = createJournal(this.workspace, before, after);
    const persistedMessages = Array.isArray(session.messages) ? session.messages : [];
    const fullReset = !Array.isArray(messages) || messages.length < persistedMessages.length;
    const delta = fullReset ? messages : messages.slice(persistedMessages.length);
    session.turns.push({
      id: randomUUID(),
      input: redactSecrets(input),
      messageCountBefore: persistedMessages.length,
      messageDelta: safeJSON(Array.isArray(delta) ? delta : []),
      agentStateBefore: agentStateBefore || null,
      agentStateAfter: agentState || null,
      journal,
      createdAt: new Date().toISOString(),
    });
    session.messages = fullReset || (Array.isArray(delta) && delta.length === 0)
      ? (Array.isArray(messages) ? safeJSON(messages) : persistedMessages)
      : [...persistedMessages, ...safeJSON(delta)];
    session.agentState = agentState || null;
    session.activeRun = agentState?.activeRun || null;
    session.parts = safeJSON(agentState?.parts || session.parts || []);
    session.redo = [];
    return this.save(session);
  }

  undo(session) {
    const turn = session.turns.at(-1);
    if (!turn) return { session, warning: "There is no turn to undo." };
    if (turn.journal) {
      if (!journalMatches(this.workspace, turn.journal, "after")) throw new Error("Cannot undo because a changed file no longer matches the recorded turn.");
      restoreJournal(this.workspace, turn.journal, "before");
    }
    session.turns.pop();
    session.redo.push(turn);
    session.messages = session.messages.slice(0, turn.messageCountBefore);
    session.agentState = turn.agentStateBefore;
    session.parts = turn.agentStateBefore?.parts || [];
    return {
      session: this.save(session),
      warning: turn.journal ? "" : "Conversation was undone. File changes cannot be restored outside a compatible Git worktree journal.",
    };
  }

  redo(session) {
    const turn = session.redo.at(-1);
    if (!turn) return { session, warning: "There is no turn to redo." };
    if (turn.journal) {
      if (!journalMatches(this.workspace, turn.journal, "before")) throw new Error("Cannot redo because a changed file no longer matches the recorded preimage.");
      restoreJournal(this.workspace, turn.journal, "after");
    }
    session.redo.pop();
    session.turns.push(turn);
    session.messages = Array.isArray(turn.messagesAfter)
      ? turn.messagesAfter
      : [...session.messages, ...(turn.messageDelta || [])];
    session.agentState = turn.agentStateAfter;
    session.parts = turn.agentStateAfter?.parts || [];
    return {
      session: this.save(session),
      warning: turn.journal ? "" : "Conversation was redone. File changes were not restored.",
    };
  }

  deleteAll() {
    if (!existsSync(this.directory)) return 0;
    const files = readdirSync(this.directory).filter(name => name.endsWith(".json"));
    for (const file of files) {
      rmSync(join(this.directory, file), { force: true });
    }
    this._cached.clear();
    return files.length;
  }

  deleteSessions(ids) {
    let deleted = 0;
    let failed = 0;
    const errors = [];
    for (const id of ids) {
      try {
        const p = this.path(id);
        if (existsSync(p)) rmSync(p, { force: true });
        const sidecar = this.partsPath(id);
        if (existsSync(sidecar)) rmSync(sidecar, { force: true });
        this._cached.delete(id);
        deleted++;
      } catch (error) {
        failed++;
        errors.push(String(error?.message || error));
      }
    }
    return { deleted, failed, errors };
  }

  exportMarkdown(session, path) {
    const lines = [`# ${session.title}`, ""];
    for (const message of session.messages || []) {
      if (!["user", "answer", "assistant"].includes(message.type || message.role)) continue;
      const role = message.type === "user" || message.role === "user" ? "User" : "KhazAI";
      lines.push(`## ${role}`, "", String(message.content || ""), "");
    }
    writeFileSync(path, `${lines.join("\n").trim()}\n`, "utf-8");
    return path;
  }
}
