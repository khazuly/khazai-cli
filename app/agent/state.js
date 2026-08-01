import { redactSecrets } from "../../lib/secrets.js";
import { sanitizeAssistantIdentity } from "../../lib/assistant-text.js";
import { resolve } from "node:path";
import { isObject, INSPECTION_TOOLS, IDEMPOTENT_MUTATION_TOOLS, toolSignature, resultFailed } from "./helpers/task.js";
import { pendingActionState, stripMarkdown } from "./helpers/parser.js";
import { completedConversationHistory } from "./request-state.js";


export class StateMethods {
  _markLatency(name) {
    if (!this._latency || this._latency[name] !== undefined) return;
    this._latency[name] = performance.now();
  }

  _finishLatency() {
    if (!this._latency) return;
    this._markLatency("completed");
    if (this.mode() === "plan") {
      this._latency.explorationMs = this._latency.completed - this._latency.inputReceived;
    }
    const metrics = {
      modeSwitchMs: this._latency.modeSwitchMs ?? null,
      explorationMs: this._latency.explorationMs ?? null,
      instructionLoadingMs: this._latency.instructionLoadingMs ?? null,
      historyPreparationMs: this._latency.historyPreparationMs ?? null,
      messageValidationMs: this._latency.messageValidationMs ?? null,
      tokenCountingMs: this._latency.tokenCountingMs ?? null,
      compactionCheckMs: this._latency.compactionCheckMs ?? null,
      compactionMs: this._latency.compactionMs ?? null,
      toolSchemaBuildMs: this._latency.toolSchemaBuildMs ?? null,
      serializationMs: this._latency.serializationMs ?? null,
      requestUploadMs: this._latency.providerFirstByte !== undefined
        ? this._latency.providerFirstByte - this._latency.requestDispatched
        : null,
      providerTimeToFirstByteMs: this._latency.providerFirstByte !== undefined
        ? this._latency.providerFirstByte - this._latency.requestDispatched
        : null,
      providerTimeToFirstTokenMs: this._latency.providerFirstDelta !== undefined && this._latency.providerFirstByte !== undefined
        ? this._latency.providerFirstDelta - this._latency.providerFirstByte
        : null,
      totalResponseMs: this._latency.completed - this._latency.inputReceived,
      messageCount: this._latency.messageCount ?? null,
      serializedPayloadBytes: this._latency.serializedPayloadBytes ?? null,
      currentContextTokens: this._latency.currentContextTokens ?? null,
      compactionLabel: this._latency.compactionLabel ?? "Not required",
    };
    this._lastRequestMetrics = metrics;
  }

  exportSessionState() {
    const state = {
      version: 5,
      sessionId: this._sessionId,
      messages: this._messages.slice(-200),
      canonicalProviderMessages: null,
      summary: this._summary,
      model: this._model,
      agent: this._agentProfile?.name || "build",
      parts: this._lifecycle.parts.slice(-200),
      permissionApprovals: this._permissionService.approvalHistory(),
      recoverableProviderRequest: this._recoverableProviderRequest,
      contextUsage: this._usageTracker.export(),
      historyRevision: this._historyRevision,
      resolvedProvider: this._model,
      resolvedModel: this._model,
    };
    return this._secretStore.redactSerializable(state);
  }

  restoreSessionState(state) {
    if (!isObject(state)) return false;
    if (Array.isArray(state.messages)) {
      const filtered = state.messages
        .filter(message => !String(message?.content || "").startsWith("[INTERNAL STEERING]"))
        .slice(-200);

      this._messages = Array.isArray(state.canonicalProviderMessages)
        ? state.canonicalProviderMessages.slice(-200)
        : completedConversationHistory(filtered);
    }
    this._messages = this._messages.map(message => {
      if (message?.role !== "tool") return message;
      const { concise, truncated } = this._conciseToolContent(message.name, message.tool_call_id, message.content);
      return truncated ? { ...message, content: concise } : message;
    });
    this._summary = typeof state.summary === "string" ? state.summary : "";
    if (state.model) this._model = String(state.model);
    if (state.sessionId) {
      this._sessionId = String(state.sessionId);
      this._lifecycle.sessionId = this._sessionId;
    }
    if (Array.isArray(state.parts)) {
      this._lifecycle.parts = state.parts
        .filter(part => (
          part?.type !== "tool"
          || !["pending", "running"].includes(part.state?.status)
        ))
        .slice(-200);
    }
    this._permissionService.restoreApprovals(state.permissionApprovals);
    this._recoverableProviderRequest = isObject(state.recoverableProviderRequest)
      ? state.recoverableProviderRequest
      : null;
    this._pendingAction = null;
    this._pendingGitPush = null;
    this._currentRequest = "";
    this._activeScope = null;
    this._plan = null;
    this._planId = null;
    this._currentStepId = null;
    this._planIndex = 0;
    this._planRevision = 0;
    this._planStatus = "active";
    this._pendingBatchCalls = [];
    this._toolCallHistory = [];
    this._completedToolResults.clear();

    if (state.historyRevision !== undefined) {
      this._historyRevision = state.historyRevision;
    }
    this._historyRevision++;
    this._contextCache.reset();
    return true;
  }

  _rememberPendingAction(details = {}) {
    this._pendingAction = pendingActionState(this._taskContract, this._activeTask, {
      evidence: this._toolEvidence,
      gitPush: this._pendingGitPush,
      ...details,
    });
  }

  _clearPendingAction() {
    this._pendingAction = null;
  }

  _pauseForRecovery({ detectedIntent, proposedAction, recommendedAction, guidance, reason = "" }) {
    const nextStep = recommendedAction || this._activeTask.nextExpectedAction || "continue the active task";
    this._activeTask.pendingProblem = redactSecrets(reason || this._activeTask.pendingProblem || "A recoverable agent step needs another attempt.");
    this._activeTask.nextExpectedAction = nextStep;
    this._rememberPendingAction({
      status: "recovering",
      reason: this._activeTask.pendingProblem,
      nextStep,
    });
    return this._steer({
      detectedIntent: detectedIntent || this._activeTask.activeIntent,
      proposedAction,
      recommendedAction: nextStep,
      guidance,
    });
  }

  _rememberInspection(tool, result) {
    if (resultFailed(result) || !INSPECTION_TOOLS.has(tool.name)) return;
    const signature = toolSignature(tool, this._workspace);
    this._inspectionCache.set(signature, String(result));
    if (tool.name === "glob") {
      const target = String(tool.args?.path || this._workspace);
      const absoluteTarget = target.startsWith("/") ? target : resolve(this._workspace, target);
      if (resolve(absoluteTarget) === resolve(this._workspace)) {
        this._workspaceListing = { result: String(result), signature };
      }
    }
  }

  _invalidateInspectionCache() {
    this._inspectionCache.clear();
    this._workspaceListing = null;
  }

  _rememberToolOutcome(tool, result, failedOverride = null) {
    const signature = toolSignature(tool, this._workspace);
    const failed = failedOverride === null ? resultFailed(result) : Boolean(failedOverride);
    this._toolCallHistory.push({ signature, failed });
    if (this._toolCallHistory.length > 24) this._toolCallHistory.shift();
    if (failed) return;
    const target = String(tool.args?.path || "");
    if (target && this._activeScope) {
      if (!this._activeScope.relevantFiles.includes(target)) this._activeScope.relevantFiles.push(target);
      if (IDEMPOTENT_MUTATION_TOOLS.has(tool.name)
        && !this._activeScope.changedFiles.includes(target)) {
        this._activeScope.changedFiles.push(target);
      }
    }
    if (IDEMPOTENT_MUTATION_TOOLS.has(tool.name)) {
      this._invalidateInspectionCache();
      this._completedToolResults.set(signature, String(result));
    } else if (INSPECTION_TOOLS.has(tool.name)) {
      this._rememberInspection(tool, result);
    }
    this._loopRecoveries = 0;
  }

  _toolLoopRecovery(tool) {
    const signature = toolSignature(tool, this._workspace);
    if (this.mode() === "plan" && this._inspectionCache.has(signature)) {
      return { result: this._inspectionCache.get(signature), cached: true, failed: false };
    }
    const repeatedFailures = this._toolCallHistory
      .filter(entry => entry.signature === signature && entry.failed)
      .length;
    const failureLimit = this.mode() === "plan" ? 1 : this._registry.resolveName?.(tool.name) ? 2 : 1;
    if (repeatedFailures >= failureLimit) return { exhausted: true };
    return null;
  }

  _filterRepeatedBatchTools(tools) {
    const executable = [];
    const invalidSignatures = new Set();
    for (const tool of tools) {
      const signature = toolSignature(tool, this._workspace);
      if (!this._registry.resolveName?.(tool.name)) {
        if (invalidSignatures.has(signature)) continue;
        invalidSignatures.add(signature);
      }
      const recovery = this._toolLoopRecovery(tool);
      if (!recovery) {
        executable.push(tool);
        continue;
      }
      if (recovery.result) {
        this._recordShellReuse(tool, recovery);
        continue;
      }
      if (recovery.exhausted) {
        this._loopRecoveryExhausted = true;
        break;
      }
    }
    return executable;
  }

  _boundedLoopRecoveryAnswer() {
    const answer = "I couldn't make further progress because the available actions kept repeating without changing the task result. Please provide the exact target or expected outcome.";
    this._appendMessage({ role: "assistant", content: answer });
    this._clearPendingAction();
    this._finishLatency();
    return answer;
  }

  _cleanAnswer(text) {
    let clean = sanitizeAssistantIdentity(this._secretStore.redact(text))
      .replace(/^final answer\s*:?\s*/im, "")
      .replace(/```\w*\n[\s\S]*?```/g, (m) => {
        const code = m.replace(/```\w*\n?/g, "").trim();
        return code;
      });
    clean = stripMarkdown(clean);
    clean = clean.replace(/\n{3,}/g, "\n\n").trim();
    return clean;
  }

  _missingCompletionEvidence() {
    const gaps = this._executionPolicy?.completionGaps?.();
    if (gaps?.length > 0) {
      return gaps.map(g => g.description).join("; ");
    }
    return null;
  }

  _completionSteering(missingEvidence) {
    const policySteering = this._executionPolicy?.completionSteering?.();
    if (policySteering) return policySteering;

    const category = this._activeTask.activeIntent || this._taskContract.category;
    const byCategory = {
      GIT_OPERATION: {
        recommendedAction: "resume the pending Git command or resolve remote, branch, upstream, or authentication",
        guidance: "Continue the pending Git operation from its last result. Ask cleanly for credentials only when authentication is required.",
      },
      MODIFICATION: {
        recommendedAction: "inspect the target and apply the smallest targeted edit or patch",
        guidance: "Continue the requested code change. Preserve unrelated code and run requested validation after the patch.",
      },
      TESTING: {
        recommendedAction: "run the relevant test or validation and recover from its result",
        guidance: "Continue the active testing task with the relevant command, then address any observed failure.",
      },
      INSPECTION: {
        recommendedAction: "perform the relevant read or search",
        guidance: "Continue the inspection until there is enough relevant information to answer the user.",
      },
      RESEARCH: {
        recommendedAction: "retry the relevant fetch or use a safe fallback",
        guidance: "Continue the active web analysis from the last fetch result instead of ending the task early.",
      },
    };
    return {
      detectedIntent: category || "UNKNOWN",
      proposedAction: "final response before the active task has finished",
      ...(byCategory[category] || {
        recommendedAction: this._activeTask.nextExpectedAction || "take the next active task action",
        guidance: "Continue from the active task state and last tool result before responding finally.",
      }),
    };
  }

  _evidenceAnswer(fallback) {
    return this._cleanAnswer(fallback);
  }

}
