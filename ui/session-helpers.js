import { Registry } from "../app/registry.js";
import { builtinTools } from "../app/builtin-tools.js";
import { applyPlanSnapshot, EMPTY_PLAN_STATE } from "../app/agent/plan.js";
import { deriveActivityLabel } from "./components/activity-bar.js";
import { normalizeVerticalWhitespace } from "./text-layout.js";
import { classifyToolState } from "./tool-presentation.js";
import { removeAssistantProtocolText, removeEmoji } from "../lib/assistant-text.js";
import { stealthModelDisplayName } from "../config/khazai-free-models.js";

const MODEL_LABELS = { "auto-free": "Auto (free)" };
export const displayModel = model => MODEL_LABELS[model] || stealthModelDisplayName(model) || model;

export function buildRegistry(workspace, mcpTools = []) {
  const r = new Registry();
  for (const tool of [...builtinTools(workspace), ...mcpTools].filter(Boolean)) r.register(tool);
  return r;
}

let msgId = 0;
export function nextId() { return `m${++msgId}`; }

export function readFileName(args) {
  const parts = String(args?.path || "").split("/").filter(Boolean);
  return parts.at(-1) || String(args?.path || "");
}

export function applyPlanEventState(state, event) {
  return applyPlanSnapshot(state || EMPTY_PLAN_STATE, event, true);
}

export function applyPlanUpdateState(state, event) {
  return applyPlanSnapshot(state || EMPTY_PLAN_STATE, event, false);
}

export function planPanelAfterFinal(state, scope, finalCommitted) {
  const matches = state.runId === scope.runId
    && state.turnId === scope.turnId
    && state.taskEpoch === scope.taskEpoch;
  return finalCommitted && matches && state.status === "completed" ? null : state.planId;
}

export function thinkActivityFromPlan(plan, phase, currentStepId = null) {
  const items = Array.isArray(plan) ? plan : [];
  const stepText = item => {
    const raw = removeEmoji(item.text || item.content || item.title || item.description || "").trim();
    return raw ? deriveActivityLabel(raw) : "Analyzing the execution context";
  };
  const stepLabel = (item, index) => items.length > 1
    ? `Step ${item.order || index + 1} of ${items.length}`
    : null;
  if (currentStepId) {
    const currentIndex = items.findIndex(item => (item.stepId || item.id) === currentStepId);
    if (currentIndex >= 0) {
      return {
        text: stepText(items[currentIndex]),
        step: stepLabel(items[currentIndex], currentIndex),
      };
    }
  }
  const activeIndex = items.findIndex(item => ["active", "running", "in_progress"].includes(item.status));
  if (activeIndex >= 0) {
    return {
      text: stepText(items[activeIndex]),
      step: stepLabel(items[activeIndex], activeIndex),
    };
  }
  const pendingIndex = items.findIndex(item => !item.status || item.status === "pending");
  if (pendingIndex >= 0) {
    return {
      text: stepText(items[pendingIndex]),
      step: stepLabel(items[pendingIndex], pendingIndex),
    };
  }
  const text = phase === "continuation"
    ? "Inspecting continuation after tool results"
    : phase === "implementation"
      ? "Preparing the implementation"
      : "Analyzing the execution context";
  return { text, step: null };
}

export function normalizeStreamText(text) {
  return normalizeVerticalWhitespace(removeAssistantProtocolText(removeEmoji(text)));
}

export function toolResultFailed(result) {
  return classifyToolState(result, true) === "failed";
}

export function isInternalAgentFailure(value) {
  return /(?:could not|couldn't|cannot)\s+parse\s+(?:the\s+)?response|invalid\s+tool\s+call|malformed\s+json|schema\s+validation|missing\s+evidence|required\s+execution\s+evidence|successful\s+workspace\s+change|acceptance\s+criteria|evidence\s+gap|\bstopped\b|\bblocked\b|\bdenied\b|safety\s+violation/i.test(String(value || ""));
}

export function isCompletionClaim(value) {
  return !/(?:task is not complete|not complete|unable to complete|failed|error|missing evidence)/i.test(String(value || ""));
}

export function formatInteractiveQuestion(question, options = []) {
  const lines = [removeEmoji(question).trim()];
  options.filter(Boolean).forEach((option, index) => {
    const label = typeof option === "string" ? option : option.label;
    lines.push(`${index + 1}. ${removeEmoji(label)}`);
  });
  return lines.filter(Boolean).join("\n");
}

