import { randomUUID } from "node:crypto";
import { redactSerializable } from "../lib/secrets.js";
import { toProviderMessages } from "../lib/providers.js";
import { canonicalModelKey } from "../config/khazai-free-models.js";

const safeJSON = value => redactSerializable(value);

function legacyToolParts(session) {
  return (session.messages || []).flatMap(message => {
    if (message?.type !== "tool") return [];
    const start = Number(message.startedAt || message.createdAt || Date.now());
    const end = Number(message.endedAt || start + Number(message.duration || 0));
    const state = message.failed
      ? { status: "error", input: { ...(message.args || {}) }, error: String(message.content || "Tool failed"), metadata: { migrated: true }, time: { start, end } }
      : { status: "completed", input: { ...(message.args || {}) }, output: String(message.content || ""), title: String(message.tool || "tool"), metadata: { migrated: true }, attachments: [], time: { start, end } };
    return [{
      id: `part_${randomUUID()}`,
      sessionId: String(session.id),
      messageId: String(message.id || `message_${randomUUID()}`),
      type: "tool",
      callId: String(message.callId || `legacy_${randomUUID()}`),
      tool: String(message.tool || "unknown"),
      state,
    }];
  });
}

export function migrateSessionV2(value) {
  const session = safeJSON(value || {});
  if (session.version === 2) return session;
  const parts = Array.isArray(session.agentState?.parts) ? session.agentState.parts : legacyToolParts(session);
  session.version = 2;
  session.parts = Array.isArray(session.parts) ? session.parts : parts;
  session.agentState = { ...(session.agentState || {}), version: 2, sessionId: session.agentState?.sessionId || session.id, parts };
  session.turns = (session.turns || []).map(turn => ({
    ...turn,
    agentStateBefore: turn.agentStateBefore ? { ...turn.agentStateBefore, version: 2, sessionId: turn.agentStateBefore.sessionId || session.id, parts: turn.agentStateBefore.parts || [] } : null,
    agentStateAfter: turn.agentStateAfter ? { ...turn.agentStateAfter, version: 2, sessionId: turn.agentStateAfter.sessionId || session.id, parts: turn.agentStateAfter.parts || [] } : null,
  }));
  return session;
}

export function migrateSessionV3(value) {
  if (value?.version === 3) return safeJSON(value);
  const session = migrateSessionV2(value);
  if (session.version === 3) return session;
  session.version = 3;
  session.parts = Array.isArray(session.parts) ? session.parts : [];
  session.agentState = session.agentState ? { ...session.agentState, version: 3, parts: session.agentState.parts || session.parts } : null;
  session.runtime = { version: 1, lastPartAt: null, ...(session.runtime || {}) };
  session.turns = (session.turns || []).map(turn => ({
    ...turn,
    agentStateBefore: turn.agentStateBefore ? { ...turn.agentStateBefore, version: 3 } : null,
    agentStateAfter: turn.agentStateAfter ? { ...turn.agentStateAfter, version: 3 } : null,
  }));
  return session;
}

function migrateAgentStateV4(state, sessionId, parts = []) {
  if (!state) return null;
  const messages = toProviderMessages((Array.isArray(state.messages) ? state.messages : [])
    .filter(message => !String(message?.content || "").startsWith("[INTERNAL STEERING]")));
  return safeJSON({
    version: 4,
    sessionId: state.sessionId || sessionId,
    messages,
    summary: typeof state.summary === "string" ? state.summary : "",
    model: state.model,
    agent: state.agent,
    parts: Array.isArray(state.parts) ? state.parts : parts,
    permissionApprovals: Array.isArray(state.permissionApprovals) ? state.permissionApprovals : [],
  });
}

export function migrateSessionV4(value) {
  if (value?.version === 4) {
    const session = safeJSON(value);
    session.permissionMode = session.permissionMode === "allow-all" ? "allow-all" : "prompt";
    return session;
  }
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
  session.permissionMode = session.permissionMode === "allow-all" ? "allow-all" : "prompt";
  return session;
}

export function migrateSessionV5(value) {
  if (value?.version === 5) return value;
  const session = migrateSessionV4(value);
  session.version = 5;
  session.runtime = { version: 3, lastPartAt: null, ...(session.runtime || {}) };
  session.runtime.version = 3;
  return session;
}

export function migrateSessionV6(value) {
  if (value?.version === 6) return value;
  const session = migrateSessionV5(value);
  session.version = 6;
  session.runtime = { version: 4, lastPartAt: null, ...(session.runtime || {}) };
  session.runtime.version = 4;
  session.activeRun = session.agentState?.activeRun || session.activeRun || null;
  return session;
}

export function canonicalizeSessionModelNames(session) {
  if (!session || typeof session !== "object") return session;
  const migrated = { ...session, model: canonicalModelKey(session.model) };
  if (migrated.agentState && typeof migrated.agentState === "object") {
    migrated.agentState = { ...migrated.agentState, model: canonicalModelKey(migrated.agentState.model) };
  }
  if (Array.isArray(migrated.turns)) {
    migrated.turns = migrated.turns.map(turn => {
      const next = { ...turn };
      for (const key of ["agentStateBefore", "agentStateAfter"]) {
        if (next[key]?.model !== undefined) next[key] = { ...next[key], model: canonicalModelKey(next[key].model) };
      }
      return next;
    });
  }
  return migrated;
}

export function validateSessionSchema(session) {
  if (!session || typeof session !== "object") throw new Error("Session data is invalid.");
  if (!session.id || typeof session.workspace !== "string") throw new Error("Session identity is invalid.");
  if (!Array.isArray(session.messages) || !Array.isArray(session.turns) || !Array.isArray(session.parts)) {
    throw new Error("Session history is invalid.");
  }
  return session;
}
