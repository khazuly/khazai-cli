import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { redactSecrets } from "../lib/secrets.js";
import { toProviderMessages } from "../lib/providers.js";

const DATA_DIR = join(homedir(), ".local", "share", "khazai-ai", "sessions");

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function workspaceKey(workspace) {
  return hash(resolve(workspace)).slice(0, 24);
}

function safeJSON(value) {
  return JSON.parse(redactSecrets(JSON.stringify(value)));
}

function legacyToolParts(session) {
  const parts = [];
  for (const message of session.messages || []) {
    if (message?.type !== "tool") continue;
    const failed = Boolean(message.failed);
    const start = Number(message.startedAt || message.createdAt || Date.now());
    const end = Number(message.endedAt || start + Number(message.duration || 0));
    parts.push({
      id: `part_${randomUUID()}`,
      sessionId: String(session.id),
      messageId: String(message.id || `message_${randomUUID()}`),
      type: "tool",
      callId: String(message.callId || `legacy_${randomUUID()}`),
      tool: String(message.tool || "unknown"),
      state: failed
        ? {
            status: "error",
            input: { ...(message.args || {}) },
            error: String(message.content || "Tool failed"),
            metadata: { migrated: true },
            time: { start, end },
          }
        : {
            status: "completed",
            input: { ...(message.args || {}) },
            output: String(message.content || ""),
            title: String(message.tool || "tool"),
            metadata: { migrated: true },
            attachments: [],
            time: { start, end },
          },
    });
  }
  return parts;
}

export function migrateSessionV2(value) {
  const session = safeJSON(value || {});
  if (session.version === 2) return session;
  const parts = Array.isArray(session.agentState?.parts)
    ? session.agentState.parts
    : legacyToolParts(session);
  session.version = 2;
  session.parts = Array.isArray(session.parts) ? session.parts : parts;
  session.agentState = {
    ...(session.agentState || {}),
    version: 2,
    sessionId: session.agentState?.sessionId || session.id,
    parts,
  };
  session.turns = (session.turns || []).map(turn => ({
    ...turn,
    agentStateBefore: turn.agentStateBefore
      ? { ...turn.agentStateBefore, version: 2, sessionId: turn.agentStateBefore.sessionId || session.id, parts: turn.agentStateBefore.parts || [] }
      : null,
    agentStateAfter: turn.agentStateAfter
      ? { ...turn.agentStateAfter, version: 2, sessionId: turn.agentStateAfter.sessionId || session.id, parts: turn.agentStateAfter.parts || [] }
      : null,
  }));
  return session;
}

export function migrateSessionV3(value) {
  if (value?.version === 3) return safeJSON(value);
  const session = migrateSessionV2(value);
  if (session.version === 3) return session;
  session.version = 3;
  session.parts = Array.isArray(session.parts) ? session.parts : [];
  session.agentState = session.agentState
    ? { ...session.agentState, version: 3, parts: session.agentState.parts || session.parts }
    : null;
  session.runtime = {
    version: 1,
    lastPartAt: null,
    ...(session.runtime || {}),
  };
  session.turns = (session.turns || []).map(turn => ({
    ...turn,
    agentStateBefore: turn.agentStateBefore
      ? { ...turn.agentStateBefore, version: 3 }
      : null,
    agentStateAfter: turn.agentStateAfter
      ? { ...turn.agentStateAfter, version: 3 }
      : null,
  }));
  return session;
}

function migrateAgentStateV4(state, sessionId, parts = []) {
  if (!state) return null;
  const messages = toProviderMessages(
    (Array.isArray(state.messages) ? state.messages : [])
      .filter(message => !String(message?.content || "").startsWith("[INTERNAL STEERING]")),
  );
  return safeJSON({
    version: 4,
    sessionId: state.sessionId || sessionId,
    messages,
    summary: typeof state.summary === "string" ? state.summary : "",
    model: state.model,
    agent: state.agent,
    parts: Array.isArray(state.parts) ? state.parts : parts,
  });
}

export function migrateSessionV4(value) {
  if (value?.version === 4) return safeJSON(value);
  const session = migrateSessionV3(value);
  session.version = 4;
  session.agentState = migrateAgentStateV4(session.agentState, session.id, session.parts);
  session.turns = (session.turns || []).map(turn => ({
    ...turn,
    agentStateBefore: migrateAgentStateV4(turn.agentStateBefore, session.id),
    agentStateAfter: migrateAgentStateV4(turn.agentStateAfter, session.id),
  }));
  session.runtime = { version: 2, lastPartAt: null, ...(session.runtime || {}) };
  session.runtime.version = 2;
  return session;
}

function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(safeJSON(value), null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function git(workspace, args, options = {}) {
  return execFileSync("git", args, {
    cwd: workspace,
    encoding: options.encoding || "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function fileState(path) {
  if (!existsSync(path)) return { exists: false, hash: null, content: null, mode: null };
  const content = readFileSync(path);
  return {
    exists: true,
    hash: hash(content),
    content: content.toString("base64"),
    mode: statSync(path).mode & 0o777,
  };
}

function statusPaths(workspace) {
  try {
    const output = git(workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const entries = output.split("\0").filter(Boolean);
    const paths = [];
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      const code = entry.slice(0, 2);
      const path = entry.slice(3);
      if (!path) continue;
      if (/R|C/.test(code) && entries[index + 1]) {
        paths.push(entries[++index]);
      }
      paths.push(path);
    }
    return [...new Set(paths)];
  } catch {
    return [];
  }
}

function headState(workspace, path) {
  try {
    const content = git(workspace, ["show", `HEAD:${path}`], { encoding: "buffer" });
    return {
      exists: true,
      hash: hash(content),
      content: content.toString("base64"),
      mode: 0o644,
    };
  } catch {
    return { exists: false, hash: null, content: null, mode: null };
  }
}

function materializeState(workspace, capture, path) {
  return capture.files[path] || headState(workspace, path);
}

function sameState(left, right) {
  return Boolean(left?.exists) === Boolean(right?.exists)
    && (left?.hash || null) === (right?.hash || null);
}

function restoreState(workspace, files) {
  for (const [relative, state] of Object.entries(files)) {
    const path = resolve(workspace, relative);
    if (!path.startsWith(`${resolve(workspace)}/`) && path !== resolve(workspace)) {
      throw new Error("Session journal contains a path outside the workspace.");
    }
    if (!state.exists) {
      rmSync(path, { recursive: true, force: true });
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(state.content, "base64"), { mode: state.mode || 0o644 });
  }
}

export class SessionStore {
  constructor(workspace, root = DATA_DIR) {
    this.workspace = resolve(workspace);
    this.directory = join(root, workspaceKey(this.workspace));
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  path(id) {
    return join(this.directory, `${id}.json`);
  }

  create({ title = "New session", model = "big-cock", agent = "build" } = {}) {
    const now = new Date().toISOString();
    const session = {
      version: 4,
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
      runtime: { version: 2, lastPartAt: null },
    };
    this.save(session);
    return session;
  }

  save(session) {
    const next = { ...session, workspace: this.workspace, updatedAt: new Date().toISOString() };
    atomicWrite(this.path(next.id), next);
    return next;
  }

  load(id) {
    const original = JSON.parse(readFileSync(this.path(id), "utf-8"));
    const data = migrateSessionV4(original);
    if (resolve(data.workspace) !== this.workspace) throw new Error("Session belongs to a different workspace.");
    if (original.version !== 4) this.save(data);
    return data;
  }

  updatePart(sessionId, part) {
    if (!sessionId || !part || !existsSync(this.path(sessionId))) return null;
    const session = this.load(sessionId);
    const parts = Array.isArray(session.parts) ? [...session.parts] : [];
    const index = parts.findIndex(item => item.id === part.id);
    if (index === -1) parts.push(safeJSON(part));
    else parts[index] = safeJSON(part);
    session.parts = parts.slice(-1_000);
    session.runtime = {
      version: 2,
      lastPartAt: new Date().toISOString(),
      activeMessageId: part.type === "step-finish" ? null : part.messageId,
    };
    if (session.agentState) session.agentState = { ...session.agentState, version: 4, parts: session.parts.slice(-200) };
    return this.save(session);
  }

  list() {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory)
      .filter(name => name.endsWith(".json"))
      .map(name => {
        try { return JSON.parse(readFileSync(join(this.directory, name), "utf-8")); } catch { return null; }
      })
      .filter(Boolean)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(({ id, title, model, agent, createdAt, updatedAt }) => ({ id, title, model, agent, createdAt, updatedAt }));
  }

  fork(id) {
    const source = this.load(id);
    const fork = this.create({
      title: `${source.title} (fork)`,
      model: source.model,
      agent: source.agent,
    });
    fork.messages = source.messages;
    fork.agentState = source.agentState;
    fork.parts = source.parts || source.agentState?.parts || [];
    return this.save(fork);
  }

  captureGitState() {
    try {
      if (git(this.workspace, ["rev-parse", "--is-inside-work-tree"]).trim() !== "true") return null;
      const files = Object.fromEntries(
        statusPaths(this.workspace).map(relative => [relative, fileState(resolve(this.workspace, relative))]),
      );
      return { head: git(this.workspace, ["rev-parse", "HEAD"]).trim(), files };
    } catch {
      return null;
    }
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
    let journal = null;
    if (before && after && before.head === after.head) {
      const paths = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])];
      journal = {
        before: Object.fromEntries(paths.map(path => [path, materializeState(this.workspace, before, path)])),
        after: Object.fromEntries(paths.map(path => [path, materializeState(this.workspace, after, path)])),
      };
      if (paths.every(path => sameState(journal.before[path], journal.after[path]))) journal = null;
    }
    session.turns.push({
      id: randomUUID(),
      input: redactSecrets(input),
      messageCountBefore: Math.max(0, session.messages.length),
      messagesAfter: safeJSON(messages),
      agentStateBefore: safeJSON(agentStateBefore),
      agentStateAfter: safeJSON(agentState),
      journal,
      createdAt: new Date().toISOString(),
    });
    session.messages = safeJSON(messages);
    session.agentState = safeJSON(agentState);
    session.parts = safeJSON(agentState?.parts || session.parts || []);
    session.redo = [];
    return this.save(session);
  }

  undo(session) {
    const turn = session.turns.at(-1);
    if (!turn) return { session, warning: "There is no turn to undo." };
    if (turn.journal) {
      for (const [path, expected] of Object.entries(turn.journal.after)) {
        if (!sameState(fileState(resolve(this.workspace, path)), expected)) {
          throw new Error(`Cannot undo because ${path} changed after the recorded turn.`);
        }
      }
      restoreState(this.workspace, turn.journal.before);
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
      for (const [path, expected] of Object.entries(turn.journal.before)) {
        if (!sameState(fileState(resolve(this.workspace, path)), expected)) {
          throw new Error(`Cannot redo because ${path} no longer matches the recorded preimage.`);
        }
      }
      restoreState(this.workspace, turn.journal.after);
    }
    session.redo.pop();
    session.turns.push(turn);
    session.messages = turn.messagesAfter;
    session.agentState = turn.agentStateAfter;
    session.parts = turn.agentStateAfter?.parts || [];
    return {
      session: this.save(session),
      warning: turn.journal ? "" : "Conversation was redone. File changes were not restored.",
    };
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
