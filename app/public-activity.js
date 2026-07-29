import { redactSecrets } from "../lib/secrets.js";

const FIELDS = ["activity", "target", "nextAction", "progress"];

function appendName(current, fragment) {
  if (!fragment || current === fragment || current.endsWith(fragment)) return current || fragment;
  return current + fragment;
}

function cleanText(value, maximum) {
  return redactSecrets(String(value || ""))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function normalizeActivity(args, redact) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const activity = cleanText(args.activity, 120);
  if (!activity) return null;
  const value = {
    activity,
    target: cleanText(args.target, 160),
    nextAction: cleanText(args.nextAction, 160),
    progress: /^\d+\s*\/\s*\d+$/.test(String(args.progress || ""))
      ? String(args.progress).replace(/\s+/g, "")
      : "",
  };
  const redacted = redact(value);
  return Object.fromEntries(FIELDS.map(field => [
    field,
    cleanText(redacted?.[field], field === "activity" ? 120 : 160),
  ]));
}

function scopeMatches(event, scope) {
  return (!event.runId || event.runId === scope.runId)
    && (!event.turnId || event.turnId === scope.turnId)
    && (!event.taskEpoch || event.taskEpoch === scope.taskEpoch);
}

export function createPublicActivityChannel(scope, redact = value => value) {
  const calls = new Map();
  return {
    accept(event = {}) {
      if (!scopeMatches(event, scope)) return [];
      if (event.type === "tool-call-delta") {
        for (const delta of event.delta || []) {
          const index = Number(delta.index || 0);
          const current = calls.get(index) || {
            index,
            toolCallId: "",
            name: "",
            argumentBuffer: "",
            completed: false,
          };
          if (delta.id) current.toolCallId = String(delta.id);
          current.name = appendName(current.name, delta.function?.name || "");
          current.argumentBuffer += delta.function?.arguments || "";
          calls.set(index, current);
        }
        return [];
      }
      if (event.type !== "finish") return [];
      const activities = [];
      for (const call of calls.values()) {
        if (call.completed || call.name.toLowerCase() !== "think" || !call.toolCallId) continue;
        call.completed = true;
        let args;
        try { args = JSON.parse(call.argumentBuffer); } catch { continue; }
        const publicActivity = normalizeActivity(args, redact);
        if (publicActivity) {
          activities.push({
            type: "public-activity",
            toolCallId: call.toolCallId,
            publicActivity,
          });
        }
      }
      return activities;
    },
  };
}
