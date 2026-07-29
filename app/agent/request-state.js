import { ExecutionPolicy } from "../execution-policy.js";
import { fallbackIntentContract, normalizeIntentContract } from "../intent-resolver.js";
import { taskState } from "./helpers/parser.js";

export function completedConversationHistory(messages) {
  const completed = new Set(messages
    .filter(message => message?.role === "tool" && message.tool_call_id)
    .map(message => message.tool_call_id));
  return messages.flatMap(message => {
    if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) return [message];
    const toolCalls = message.tool_calls.filter(call => completed.has(call.id));
    if (toolCalls.length) return [{ ...message, tool_calls: toolCalls }];
    return message.content ? [{ ...message, tool_calls: undefined }] : [];
  });
}

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
    requestStartIndex: agent._requestStartIndex,
    taskEpoch: agent._activeRun?.taskEpoch,
    attempts: Math.max(1, Number(error?.attempts) || 1),
    status: Number(error?.status) || null,
    streamPhase: phase,
    retryLog: Array.isArray(error?.retryLog) ? error.retryLog : [],
  };
}

export function prepareProviderRetry(agent, scope = null) {
  const failed = agent._recoverableProviderRequest;
  agent._currentRequest = String(failed?.currentRequest || "");
  const matchingRequest = agent._messages.findLastIndex(message => (
    message.role === "user" && message.content === agent._currentRequest
  ));
  agent._requestStartIndex = matchingRequest >= 0
    ? matchingRequest
    : Math.max(0, Number(failed?.requestStartIndex) || 0);
  agent._aborted = false;
  agent._turn = 0;
  if (!agent._executionPolicy) {
    agent._executionPolicy = new ExecutionPolicy(fallbackIntentContract(agent._currentRequest));
    agent._taskContract = agent._executionPolicy.contract;
    agent._activeTask = taskState(agent._taskContract, agent._currentRequest);
  }
  agent._activeScope = {
    sessionId: agent._sessionId,
    runId: scope?.runId,
    turnId: scope?.turnId,
    objective: agent._currentRequest,
    taskEpoch: scope?.taskEpoch,
    relevantFiles: [...(agent._activeTask?.targetFiles || [])],
    allowedTargets: [],
    currentPlan: Array.isArray(agent._plan) ? agent._plan.map(item => ({ ...item })) : [],
    changedFiles: [],
  };
}

export async function initializeAgentRequest(agent, input, signal, authorizedInput = input, scope = null) {
  agent._recoverableProviderRequest = null;
  agent._messages = completedConversationHistory(agent._messages);
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
  agent._lastToolIsRead = false;
  agent._lastAnalysis = null;
  agent._depsInstalled = false;
  agent._readFiles.clear();
  agent._autoReadDone.clear();
  agent._consecutiveWrites = 0;
  agent._consecutiveBash = 0;
  agent._pendingBatchCalls = [];
  agent._acceptedCreationOffer = null;
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
  const objective = String(input);
  let contract = fallbackIntentContract(objective);
  agent._activeScope = {
    sessionId: agent._sessionId,
    runId: scope?.runId,
    turnId: scope?.turnId,
    objective,
    taskEpoch: scope?.taskEpoch,
    relevantFiles: [...taskState(contract, objective).targetFiles],
    allowedTargets: [],
    currentPlan: [],
    changedFiles: [],
  };
  if (agent._intentResolver?.resolve) {
    try {
      const resolved = await agent._intentResolver.resolve({
        input: authorizedInput,
        model: agent._model,
        signal,
      });
      if (resolved) contract = normalizeIntentContract(resolved, objective);
    } catch {}
  }
  if (scope && !agent._isActiveRun(scope)) return false;
  agent._executionPolicy = new ExecutionPolicy(contract);
  agent._taskContract = agent._executionPolicy.contract;
  agent._activeTask = taskState(agent._taskContract, objective);
  agent._activeScope.relevantFiles = [...agent._activeTask.targetFiles];
  return true;
}
