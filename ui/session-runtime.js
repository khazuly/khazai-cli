import { Registry } from "../app/registry.js";
import { builtinTools } from "../app/builtin-tools.js";
import { normalizeVerticalWhitespace } from "./text-layout.js";
import { classifyToolState } from "./tool-presentation.js";
import { removeAssistantProtocolText, removeEmoji } from "../lib/assistant-text.js";
export { streamViewportText } from "./stream-viewport.js";

const MODEL_LABELS = { "auto-free": "Auto (free)" };
let messageSequence = 0;

export function displayModel(model) {
  return MODEL_LABELS[model] || model;
}

export function buildRegistry(workspace, mcpTools = []) {
  const registry = new Registry();
  for (const tool of [...builtinTools(workspace), ...mcpTools].filter(Boolean)) {
    registry.register(tool);
  }
  return registry;
}

export function nextId() {
  return `m${++messageSequence}`;
}

export function normalizeStreamText(text) {
  return normalizeVerticalWhitespace(removeAssistantProtocolText(removeEmoji(text)));
}

export function shouldShowCompletionSummary({ mutatedFiles, failedTools }) {
  return Number(failedTools) > 0 || Number(mutatedFiles?.size || mutatedFiles?.length || 0) > 0;
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
  options.filter(Boolean).forEach((option, index) => lines.push(`${index + 1}. ${removeEmoji(option)}`));
  return lines.filter(Boolean).join("\n");
}
