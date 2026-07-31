import { ExecutionPolicy } from "../execution-policy.js";
import { fallbackIntentContract, normalizeIntentContract } from "../intent-resolver.js";
import { taskState } from "./helpers/parser.js";
import { classifyProviderFailure, isRetryableFailure } from "../../lib/provider-reliability.js";

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
  return isRetryableFailure(error?.failureClass || classifyProviderFailure(error));
}

export function providerFailureContent(error, model = "Model") {
  const attempts = Math.max(1, Number(error?.attempts) || 1);
  const status = Number(error?.status);
  const failureClass = error?.failureClass || classifyProviderFailure(error);
  if (failureClass === "invalid_tool_schema") {
    return "[×] Provider request was rejected because a tool schema is invalid.";
  }
  if (failureClass === "unsupported_parameter") {
    return "[×] Provider request used a parameter that this route does not support.";
  }
  if (failureClass === "malformed_payload") {
    return "[×] Provider request payload was rejected.";
  }
  if (failureClass === "unhealthy_tool_route") {
    return "[×] The selected model route is temporarily unavailable for tool calls.";
  }
  if (failureClass === "unhealthy_model_route" || failureClass === "provider_infrastructure") {
    const modelName = model && model !== "Model" ? String(model) : null;
    return modelName
      ? `[×] ${modelName} is temporarily unavailable.`
      : "[×] Request failed · Model route temporarily unavailable";
  }
  if (status) {
    return `[×] ${model} provider returned HTTP ${status} after ${attempts} attempt${attempts === 1 ? "" : "s"}.`;
  }
  return `[×] ${model} provider failed after ${attempts} attempt${attempts === 1 ? "" : "s"}.`;
}

export function rememberProviderFailure(agent, error, model, phase) {
  agent._recoverableProviderRequest = {
    model,
    currentRequest: agent._currentRequest,
    requestStartIndex: agent._requestStartIndex,
    taskEpoch: agent._activeRun?.taskEpoch,
    attempts: Math.max(1, Number(error?.attempts) || 1),
    status: Number(error?.status) || null,
    failureClass: error?.failureClass || classifyProviderFailure(error),
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
    agent._executionPolicy = new ExecutionPolicy(
      fallbackIntentContract(agent._currentRequest),
      { planning: agent._agentProfile?.name === "plan" },
    );
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
  agent._historyRevision++;
  agent._appendMessage({ role: "user", content: input });
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
  agent._planId = null;
  agent._currentStepId = null;
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
  agent._executionPolicy = new ExecutionPolicy(contract, {
    planning: agent._agentProfile?.name === "plan",
  });
  agent._taskContract = agent._executionPolicy.contract;
  agent._activeTask = taskState(agent._taskContract, objective);
  agent._activeScope.relevantFiles = [...agent._activeTask.targetFiles];
  return true;
}
