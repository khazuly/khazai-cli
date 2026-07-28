import { ExecutionPolicy } from "../execution-policy.js";
import { fallbackIntentContract, normalizeIntentContract } from "../intent-resolver.js";
import { taskState } from "./helpers/parser.js";

export function recoverableProviderFailure(error) {
  const status = Number(error?.status);
  if ([500, 502, 503, 504].includes(status)) return true;
  const code = String(error?.code || error?.cause?.code || "").toUpperCase();
  return ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "PREMATURE_STREAM"].includes(code)
    || /connection reset|socket hang up|premature stream|stream ended before completion|terminated unexpectedly/i
      .test(String(error?.message || error));
}

export function providerFailureContent(error) {
  const attempts = Math.max(1, Number(error?.attempts) || 1);
  const status = Number(error?.status);
  const detail = status ? `HTTP ${status}` : "connection error";
  return `[×] Model request failed after ${attempts} attempt${attempts === 1 ? "" : "s"} · ${detail}`;
}

export function rememberProviderFailure(agent, error, model, phase) {
  agent._recoverableProviderRequest = {
    model,
    currentRequest: agent._currentRequest,
    attempts: Math.max(1, Number(error?.attempts) || 1),
    status: Number(error?.status) || null,
    streamPhase: phase,
    retryLog: Array.isArray(error?.retryLog) ? error.retryLog : [],
  };
}

export function prepareProviderRetry(agent) {
  agent._aborted = false;
  agent._turn = 0;
  if (agent._executionPolicy) return;
  agent._executionPolicy = new ExecutionPolicy(fallbackIntentContract(agent._currentRequest));
  agent._taskContract = agent._executionPolicy.contract;
  agent._activeTask = taskState(agent._taskContract, agent._currentRequest);
}

export async function initializeAgentRequest(agent, input, signal) {
  agent._recoverableProviderRequest = null;
  agent._messages.push({ role: "user", content: input });
  agent._requestStartIndex = agent._messages.length - 1;
  agent._currentRequest = input;
  agent._pendingAction = null;
  agent._pendingGitPush = null;
  agent._requestMode = "neutral";
  agent._requiresPlan = false;
  agent._planningPhase = false;
  agent._turn = 0;
  agent._aborted = false;
  agent._lastToolWasExecuted = false;
  agent._totalWrites = 0;
  agent._plan = null;
  agent._planIndex = 0;
  agent._lastToolResult = null;
  agent._toolCallHistory = [];
  agent._completedToolResults.clear();
  agent._loopRecoveries = 0;
  agent._loopRecoveryExhausted = false;
  agent._invalidateInspectionCache();
  agent._inspectionCommands.clear();
  agent._readOnlyRedirects = 0;
  agent._planNarrations = 0;
  agent._planMismatches = 0;
  agent._postPlanToolRedirects = 0;
  agent._invalidToolResponses = 0;
  agent._emptyResponses = 0;
  agent._transportFailures = 0;
  agent._toolEvidence = [];
  agent._mutationSnapshots.clear();
  agent._patchReviews.clear();
  agent._cachedInspectionRedirects = 0;
  agent._completionRedirects = 0;
  agent._resolvedArtifactDocumentation = false;
  agent._researchSources = [];
  let contract = fallbackIntentContract(agent._currentRequest);
  if (agent._intentResolver?.resolve) {
    try {
      const resolved = await agent._intentResolver.resolve({
        input: agent._currentRequest,
        model: agent._model,
        signal,
      });
      if (resolved) contract = normalizeIntentContract(resolved, agent._currentRequest);
    } catch {}
  }
  agent._executionPolicy = new ExecutionPolicy(contract);
  agent._taskContract = agent._executionPolicy.contract;
  agent._activeTask = taskState(agent._taskContract, agent._currentRequest);
}
