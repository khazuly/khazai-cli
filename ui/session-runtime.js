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

export function permissionModeCommand(argument, currentMode = "prompt") {
  const action = String(argument || "").trim().toLowerCase();
  if (action === "status") {
    return {
      mode: currentMode === "allow-all" ? "allow-all" : "prompt",
      changed: false,
      message: currentMode === "allow-all"
        ? "All tool permissions are allowed for this session."
        : "Tool permissions require approval for this session.",
    };
  }
  if (action === "off") {
    return {
      mode: "prompt",
      changed: currentMode !== "prompt",
      message: "Normal permission prompts are restored for this session.",
    };
  }
  if (action && action !== "on") {
    return {
      mode: currentMode === "allow-all" ? "allow-all" : "prompt",
      changed: false,
      error: "Usage: /allow-all [status|off]",
    };
  }
  return {
    mode: "allow-all",
    changed: currentMode !== "allow-all",
    message: "All tool permissions are allowed for this session.",
  };
}

function responseScopeMatches(state, scope) {
  return Boolean(
    state
    && state.runId === scope.runId
    && state.turnId === scope.turnId
  );
}

export function createResponseBuffer({ runId, turnId }) {
  return {
    runId,
    turnId,
    responsePhase: "final",
    finalBuffer: "",
    finalCommitted: false,
    status: "idle",
    responseId: `response-${turnId}`,
  };
}

export function appendResponseDelta(state, scope, delta) {
  if (!responseScopeMatches(state, scope) || state.finalCommitted || state.status === "discarded") {
    return state;
  }
  return {
    ...state,
    finalBuffer: state.finalBuffer + String(delta || ""),
    status: "collecting",
  };
}

export function resetResponseBuffer(state, scope) {
  if (!responseScopeMatches(state, scope) || state.finalCommitted) return state;
  return { ...state, finalBuffer: "", status: "idle" };
}

export function discardResponseBuffer(state, scope) {
  if (!responseScopeMatches(state, scope) || state.finalCommitted) return state;
  return { ...state, finalBuffer: "", status: "discarded" };
}

export function prepareRunInterruption({ submitting, scope, cancelledRunId, responseBuffer }) {
  if (!submitting || !scope || cancelledRunId === scope.runId) {
    return { accepted: false, runId: cancelledRunId, responseBuffer };
  }
  return {
    accepted: true,
    runId: scope.runId,
    responseBuffer: discardResponseBuffer(responseBuffer, scope),
  };
}

export function commitResponseBuffer(state, scope) {
  if (
    !responseScopeMatches(state, scope)
    || state.finalCommitted
    || state.status === "discarded"
  ) {
    return { state, response: null };
  }
  const response = state.finalBuffer
    ? { id: state.responseId, content: state.finalBuffer }
    : null;
  return {
    state: {
      ...state,
      finalBuffer: "",
      finalCommitted: true,
      status: "committed",
    },
    response,
  };
}

const ISSUE_TEXT = {
  validation: "Required verification did not complete",
  mutation: "Required change did not complete",
  deletion: "Required deletion did not complete",
  inspection: "Required inspection did not complete",
  research: "Required research did not complete",
  git: "Required Git operation did not complete",
};

export function terminalRunResult({
  cancelled = false,
  completionGaps = [],
  fatalError = "",
  finalCommitted = false,
  finishedNormally = false,
} = {}) {
  if (cancelled) {
    return {
      status: "cancelled",
      unresolvedIssues: [],
      verificationPassed: false,
      finalCommitted: false,
    };
  }
  const unresolvedIssues = [
    fatalError ? String(fatalError) : null,
    ...completionGaps.map(gap => ISSUE_TEXT[gap.kind] || gap.description),
    !fatalError && (!finishedNormally || !finalCommitted)
      ? "The final response did not complete"
      : null,
  ].filter(Boolean);
  return {
    status: unresolvedIssues.length ? "failed" : "completed",
    unresolvedIssues: [...new Set(unresolvedIssues)],
    verificationPassed: !completionGaps.some(gap => gap.kind === "validation"),
    finalCommitted: Boolean(finalCommitted),
  };
}
