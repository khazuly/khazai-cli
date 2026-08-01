import { execAsync } from "../../lib/exec-async.js";
import { countTokens } from "../../lib/tokens.js";
import { existsSync, readFileSync, statSync, writeFileSync, mkdtempSync, chmodSync, rmSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { redactSecrets } from "../../lib/secrets.js";
import { ToolExecutor } from "../tool-executor.js";
import { normalizeIntentContract } from "../intent-resolver.js";
import { randomUUID } from "node:crypto";
import { planToolDefinitionAllowed } from "../plan-mode.js";
import { planBatchCanRunConcurrently, runPlanExplorationBatch } from "./plan-exploration.js";
import { isObject, workspaceMetadata, INSPECTION_TOOLS, IDEMPOTENT_MUTATION_TOOLS, MAX_LOOP_RECOVERIES, sourceUrls, deterministicIdentityAnswer, extractPlan, normalizePlan, requiresPlan, fallbackPlan, extractInteractiveQuestion, toolSignature, publicToolArgs, repeatedToolCycle, cachedToolAnswer, requestMode, declaredSymbols, preservesImplementationStructure, prospectiveFileContent, shouldDeferToolCandidateProse, wantsFileCount, simpleFileListRequest, fileCountFromToolResult, resultFailed, isSteeringOutcome, legacyGuardOutcome, guardErrorOutcome, patchReview, toolMetadata, requestedSampleExtensions, needsFileMutation, needsDeletionMutation, clearWorkspaceRequest, isDeletionCommand, needsExecutionValidation, isValidationCommand, expectedPlanTools, mutationSatisfiesPlanItem, toolMatchesPlanItem, isInspectionCommand, mutatesWorkspace, streamDisposition } from "./helpers/task.js";
import { isProviderParseFailure, isShortContinuation, isNegativeContinuation, pendingActionState, offeredModificationContract, offersFollowUpAction, taskState, extractJsonCandidates, decodeXmlEntities, coerceTaggedArgument, extractTaggedToolCall, LEGACY_PROTOCOL_HOLDBACK, MAX_PROSE_CONTINUATIONS, jsonCompletion, validateToolArguments, delimiterCount, proseLooksIncomplete, stripMarkdown, joinProseContinuation } from "./helpers/parser.js";

export class ToolMethods {
  _protectForContext(value, scope = this._activeRun) {
    return this._secretStore.protect(
      value,
      scope?.runId,
      scope?.turnId,
    );
  }

  _protectDataForContext(value, scope = this._activeRun) {
    return this._secretStore.protectSerializable(
      value,
      scope?.runId,
      scope?.turnId,
    );
  }

  _scopedToolEvent(event, scope = this._activeRun) {
    return {
      ...event,
      runId: scope?.runId,
      turnId: scope?.turnId,
      taskEpoch: scope?.taskEpoch,
    };
  }

  _recordShellReuse(tool, decision) {
    const result = this._protectForContext(String(decision.result || ""));
    this._appendMessage({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: tool.id,
        type: "function",
        function: { name: tool.name, arguments: JSON.stringify(this._protectDataForContext(publicToolArgs(tool.args))) },
      }],
    });
    this._pushToolMessage(tool.name, tool.id, result);
    this._toolEvidence.push({
      tool: tool.name,
      args: { ...tool.args },
      result,
      failed: decision.failed,
      metadata: { cached: Boolean(decision.cached), blocked: Boolean(decision.blocked) },
    });
    this._lastToolResult = result;
    this._activeTask.lastToolResult = result.slice(0, 1500);
  }

  _finalizeShellBlocker(result) {
    const answer = String(result || "Shell execution is blocked.");
    this._appendMessage({ role: "assistant", content: answer });
    this._activeTask.pendingProblem = answer;
    this._lifecycle.finishStep("tool-error");
    this._clearPendingAction();
    this._finishLatency();
    return answer;
  }

  _schedulableShellCalls(calls) {
    return calls.filter(call => {
      if (call.name !== "bash") return true;
      call.id ||= randomUUID();
      const decision = this._shellScheduler.reserve(call);
      if (!decision) return true;
      this._recordShellReuse(call, decision);
      return false;
    });
  }

  async *_runSequentialBatch(tools) {
    const executionScope = this._activeRun;
    if (!this._isActiveRun(executionScope)) return true;
    const candidates = tools.slice(0, 8).map(tool => this._normalizeTool(tool));
    const calls = this._schedulableShellCalls(this._filterRepeatedBatchTools(candidates));
    if (this._loopRecoveryExhausted || calls.length === 0) {
      this._lifecycle.finishStep("tool-calls");
      return true;
    }
    this._appendMessage({
      role: "assistant",
      content: null,
      tool_calls: calls.map(call => ({
        id: call.id || (call.id = randomUUID()),
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(this._protectDataForContext(publicToolArgs(call.args))),
        },
      })),
    });
    yield this._scopedToolEvent({ type: "context-usage", usage: this.contextUsage() }, executionScope);
    if (planBatchCanRunConcurrently(this, calls)) {
      for (const call of calls) {
        yield this._scopedToolEvent({
          type: "tool-call",
          tool: call.name,
          args: { ...call.args },
          callId: call.id,
        }, executionScope);
      }
      yield* runPlanExplorationBatch(this, calls, executionScope);
      return true;
    }
    let failed = false;
    for (const call of calls) {
      if (!this._isActiveRun(executionScope)) return true;
      const registeredTool = this._registry.get(call.name);
      if (registeredTool) {
        yield this._scopedToolEvent({ type: "tool-call", tool: call.name, args: { ...call.args }, callId: call.id }, executionScope);
      }
      if (!this._isActiveRun(executionScope)) return true;
      const planTracker = !registeredTool || ["todowrite", "think"].includes(call.name)
        ? null
        : yield* this._startPlanItem(call, executionScope);
      let callFailed = false;
      let completedPart = null;
      let bufferedPlanResult = null;
      for await (const event of this._toolExecutor(executionScope).execute(call, { agent: this._agentProfile?.name })) {
        if (event.type !== "execution-result") {
          if (event.type === "tool-result" && call.name === "todowrite") bufferedPlanResult = event;
          else yield event;
          continue;
        }
        const result = this._protectForContext(String(event.result));
        const displayResult = this.redactForDisplay(result);
        completedPart = event.part;
        failed ||= event.failed;
        callFailed ||= event.failed;
        const metadata = toolMetadata(event.call, displayResult);
        this._rememberToolOutcome(event.call, result, event.failed);
        this._toolEvidence.push({
          tool: event.call.name,
          args: this._protectDataForContext(event.call.args),
          result,
          failed: event.failed,
          metadata,
        });
        this._pushToolMessage(event.call.name, event.call.id, result);
        yield this._scopedToolEvent({ type: "context-usage", usage: this.contextUsage() }, executionScope);
        this._lastToolResult = result;
        this._activeTask.lastToolResult = result.slice(0, 1500);
      }
      if (!this._isActiveRun(executionScope)) return true;
      if (call.name === "todowrite" && completedPart?.state.status === "completed") {
        const todos = Array.isArray(completedPart.state.metadata?.todos) ? completedPart.state.metadata.todos : [];
        const plan = this._definePlan(todos, executionScope);
        if (plan) yield this._scopedToolEvent({
          type: "plan",
          items: plan.map(item => ({ ...item })),
          planId: this._planId,
          currentStepId: this._currentStepId,
          revision: this._planRevision,
          planStatus: this._planStatus,
        }, executionScope);
      }
      if (bufferedPlanResult) {
        yield this._scopedToolEvent({
          ...bufferedPlanResult,
          metadata: {
            ...(bufferedPlanResult.metadata || {}),
            planItems: Array.isArray(this._plan) ? this._plan.map(item => ({ ...item })) : [],
          },
        }, executionScope);
      }
      yield* this._finishPlanItem(
        planTracker,
        call,
        completedPart?.state.output || this._lastToolResult,
        !callFailed,
        executionScope,
      );
    }
    for (const part of this._lifecycle.finishStep(failed ? "tool-error" : "tool-calls")) {
      yield this._scopedToolEvent({ type: "tool-part", part }, executionScope);
    }
    this._lastToolWasExecuted = calls.length > 0;
    return true;
  }

  _contextLimitKnown() {
    return Boolean(this._applyEffectiveSettings().contextLimit);
  }

  contextUsage() {
    const effective = this._applyEffectiveSettings();
    const contextLimit = effective.contextLimit;
    const source = effective.contextLimitSource;
    this._usageTracker.setContextLimitSource(source);
    const entry = this._frame();
    const snapshot = this._usageTracker.snapshot(entry.messages, contextLimit, {
      estimated: true,
      compactionStatus: this._compaction.status,
      compactionStartedAt: this._compaction.startedAt,
      stableTokens: this._compaction.stableTokens,
      historyRevision: this._historyRevision,
      contextTokens: entry.jsonTokens,
    });
    snapshot.contextLimitSource = source;
    return snapshot;
  }

  compactIfNeeded() {
    const usage = this.contextUsage();
    if (!usage.contextLimitKnown) return false;
    const ratio = usage.projectedRequestTokens / usage.contextLimit;
    const emergency = Number(this._config.emergencyCompactThreshold) || 0.92;
    if (ratio >= emergency) {
      return this._compactMessages(true);
    }
    if (ratio < this._config.compactThreshold) return false;
    return this._compactMessages(false);
  }

  /**
   * Projects the normalized provider payload (messages + tool schemas) for
   * the resolved route so the loop can compact at a safe boundary before
   * dispatching instead of sending an oversized request first. Results are
   * cached per history/model/tool-registry/capability revision so unchanged
   * history is never re-normalized and re-serialized on every iteration.
   */
  async _projectProviderPayload(ctx, tools, model) {
    const projectionKey = [
      this._lastFrameKey || this._contextCacheKey(),
      `m:${model}`,
      `t:${this._registry.revision}`,
      `c:${this._providerCapabilityRevision || 0}`,
    ].join("|");
    const cached = this._contextCache.projection(projectionKey);
    if (cached) return cached;
    const serializationStart = performance.now();
    try {
      const { estimateProviderPayload } = await import("../../lib/llm.js");
      const projection = estimateProviderPayload(ctx, tools, model);
      const effective = this._applyEffectiveSettings();
      const limit = Number(projection.contextLimit
        || effective.contextLimit
        || this._providerContextLimit
        || 0);
      const result = {
        tokens: Number(projection.tokens) || 0,
        contextLimit: limit || null,
        ratio: limit > 0 ? (Number(projection.tokens) || 0) / limit : null,
      };
      this._markLatencyDuration("serializationMs", serializationStart);
      this._contextCache.setProjection(projectionKey, result);
      return result;
    } catch {
      this._markLatencyDuration("serializationMs", serializationStart);
      return { tokens: 0, contextLimit: null, ratio: null };
    }
  }

  /**
   * Builds the provider tool list once per model/agent/tool-registry
   * revision. Definition hooks run at most once per revision; the mapped
   * native schema list is reused until the registry or model changes.
   */
  async _toolSchemas(model, agent) {
    const mode = this.mode();
    const key = `${model}|${agent}|${mode}|${this._registry.revision}`;
    const cached = this._toolSchemaCache.get(key);
    if (cached) return cached;
    const schemaStart = performance.now();
    const available = await this._registry.definitions({ model, agent, mode, directory: this._workspace });
    const definitions = mode === "plan" ? available.filter(planToolDefinitionAllowed) : available;
    const nativeTools = definitions.map(tool => ({
      type: "function",
      function: {
        name: tool.name,
        description: String(tool.description || ""),
        parameters: tool.parameters || { type: "object", properties: {} },
      },
    }));
    this._markLatencyDuration("toolSchemaBuildMs", schemaStart);
    this._contextCache.stats.toolSchemaBuilds++;
    this._toolSchemaCache.set(key, nativeTools);
    return nativeTools;
  }

  _buildCompactedMessages(force = false) {
    const contextUsage = this.contextUsage();
    const usage = contextUsage.currentContextTokens;
    const contextLimit = this._applyEffectiveSettings().contextLimit
      || Math.max(1, Number(this._config.tokenBudget) || 24_000);
    if (!force) {
      const threshold = contextLimit * this._config.compactThreshold;
      if (contextUsage.projectedRequestTokens < threshold) return null;
    }
    if (this._messages.length < 2) return null;

    const target = contextLimit * (force ? 0.2 : 0.45);
    const preserveTurns = Math.max(0, Number(this._config.preserveRecentTurns) || 0);
    let keptTokens = 0;
    let keepFrom = this._messages.length;
    if (!force && preserveTurns > 0) {
      let turns = 0;
      for (let index = this._messages.length - 1; index >= 0 && turns < preserveTurns; index--) {
        const message = this._messages[index];
        if (String(message.content || "").startsWith("[INTERNAL STEERING]")) continue;
        keepFrom = index;
        keptTokens += this._contextCache.messageMeta(message).size;
        if (message.role === "assistant" && message.content) turns++;
      }
    }
    for (let index = keepFrom - 1; index >= 0; index--) {
      const message = this._messages[index];
      if (String(message.content || "").startsWith("[INTERNAL STEERING]")) continue;
      const size = this._contextCache.messageMeta(message).size;
      if (keptTokens > 0 && keptTokens + size > target) break;
      keptTokens += size;
      keepFrom = index;
    }
    while (keepFrom > 0 && this._messages[keepFrom]?.role === "tool") keepFrom--;

    const earlier = this._messages.slice(0, keepFrom);
    const transcript = earlier
      .filter(message => ["user", "assistant"].includes(message.role) && message.content)
      .map(message => `${message.role === "user" ? "User" : "Assistant"}: ${String(message.content)}`)
      .join("\n")
      .slice(-6000);

    const planBlock = this._preservePlanBlock();
    const newSummary = transcript
      ? [this._summary, planBlock, transcript].filter(Boolean).join("\n").slice(-Math.max(512, this._maxSummaryChars()))
      : [this._summary, planBlock].filter(Boolean).join("\n").slice(-Math.max(512, this._maxSummaryChars()));

    const kept = this._messages.slice(keepFrom);
    return {
      messages: kept,
      summary: newSummary,
      requestStartIndex: Math.max(0, this._requestStartIndex - keepFrom),
    };
  }

  _maxSummaryChars() {
    return Math.max(512, (Number(this._config.maxCompactedSummarySize) || 2048) * 4);
  }

  _preservePlanBlock() {
    const parts = [];
    if (Array.isArray(this._plan) && this._plan.length) {
      const step = this._currentStepId
        ? this._plan.find(item => item.stepId === this._currentStepId)
        : null;
      parts.push(`Active plan: ${this._plan.length} step(s); current: ${step?.title || step?.description || this._currentStepId || "next"}`);
    }
    if (this._activeScope?.changedFiles?.length) {
      parts.push(`Modified files: ${this._activeScope.changedFiles.join(", ")}`);
    }
    if (this._activeTask?.pendingProblem) {
      parts.push(`Unresolved: ${String(this._activeTask.pendingProblem).slice(0, 500)}`);
    }
    return parts.length ? `\nContext state: ${parts.join(" · ")}` : "";
  }

  _compactMessages(force = false) {
    const result = this._buildCompactedMessages(force);
    if (!result) return false;
    this._messages = result.messages;
    this._summary = result.summary;
    this._requestStartIndex = result.requestStartIndex;
    this._usageTracker.bumpHistoryRevision();
    this._historyRevision = this._usageTracker.historyRevision;
    this._lastFrameEntry = null;
    this._contextCache.reset();
    return true;
  }

  async _getRemoteUrl() {
    try {
      const result = await execAsync("git remote get-url origin", {
        cwd: this._workspace,
        timeoutMs: 10_000,
      });
      return (result.stdout || "").trim() || null;
    } catch {
      return null;
    }
  }

  async _runBash(command, workdir) {
    try {
      const result = await execAsync(command, {
        cwd: workdir || this._workspace,
        timeoutMs: 30_000,
      });
      return `Exit: 0\n${redactSecrets(result.stdout || result.stderr || "")}`;
    } catch (error) {
      return `Exit: 1\n${redactSecrets([error?.stdout, error?.stderr, error?.message].filter(Boolean).join("\n"))}`;
    }
  }

  async _pushWithTemporaryCredential(command, token) {
    const directory = mkdtempSync(join(tmpdir(), "khazai-git-askpass-"));
    const askpass = join(directory, "askpass.sh");
    try {
      writeFileSync(askpass, "#!/bin/sh\nprintf '%s' \"$KHAZAI_GIT_TOKEN\"\n", { mode: 0o700 });
      chmodSync(askpass, 0o700);
      const result = await execAsync(command, {
        cwd: this._workspace,
        timeoutMs: 60_000,
        env: { GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: "0", KHAZAI_GIT_TOKEN: token },
      });
      return { ok: true, result: `Exit: 0\n${redactSecrets(result.stdout || result.stderr || "Push completed.")}` };
    } catch (error) {
      const detail = redactSecrets([error?.stdout, error?.stderr, error?.message].filter(Boolean).join("\n"));
      const auth = /auth|credential|password|token|permission denied|401|403/i.test(detail);
      return { ok: false, result: auth ? "Push failed because authentication was rejected." : "Push failed. Check the remote, branch, and connection, then try again." };
    } finally {
      try { rmSync(directory, { recursive: true, force: true }); } catch {}
    }
  }

  async *_runShellShortcut(input) {
    const executionScope = this._activeRun;
    if (!this._isActiveRun(executionScope)) return;
    const command = String(input || "").slice(1).trim();
    if (!command) {
      const answer = "Enter a command after !.";
      this._appendMessage({ role: "user", content: input });
      this._appendMessage({ role: "assistant", content: answer });
      yield { type: "stream", token: answer };
      yield { type: "stream-end" };
      return;
    }

    const protectedInput = this._protectForContext(input);
    this._taskContract = normalizeIntentContract({
      intent: "change",
      category: "SHELL_OPERATION",
      operation: "shell",
      requiredEvidence: ["shell"],
      modifiesFiles: false,
    }, protectedInput);
    this._activeTask = taskState(this._taskContract, protectedInput);
    this._currentRequest = protectedInput;
    this._activeScope = {
      sessionId: this._sessionId,
      runId: executionScope.runId,
      turnId: executionScope.turnId,
      objective: protectedInput,
      taskEpoch: executionScope.taskEpoch,
      relevantFiles: [],
      allowedTargets: [],
      currentPlan: [],
      changedFiles: [],
    };
    this._appendMessage({ role: "user", content: protectedInput });
    this._requestStartIndex = this._messages.length - 1;
    this._toolEvidence = [];
    this._toolCallHistory = [];
    this._completedToolResults.clear();
    this._invalidateInspectionCache();

    const snapshot = this._lifecycle.startStep();
    if (snapshot) yield this._scopedToolEvent({ type: "tool-part", part: snapshot }, executionScope);
    const call = {
      id: randomUUID(),
      name: "bash",
      args: { command, workdir: this._workspace },
    };
    this._shellScheduler.reserve(call);
    yield this._scopedToolEvent({ type: "tool-call", tool: call.name, args: { ...call.args }, callId: call.id }, executionScope);
    if (!this._isActiveRun(executionScope)) return;
    this._appendMessage({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(this._protectDataForContext(publicToolArgs(call.args))),
        },
      }],
    });
    let result = "";
    let failed = false;
    let finishReason = "tool-calls";
    for await (const event of this._toolExecutor(executionScope).execute(call, { agent: this._agentProfile?.name })) {
      if (event.type === "execution-result") {
        result = this._protectForContext(String(event.result || ""));
        failed = Boolean(event.failed);
        finishReason = event.finishReason;
      } else {
        yield event;
      }
    }
    if (!this._isActiveRun(executionScope)) return;
    this._pushToolMessage(call.name, call.id, result);
    this._toolEvidence.push({ tool: "bash", args: call.args, result, failed, metadata: toolMetadata(call, result) });
    this._lastToolResult = result;
    this._activeTask.lastToolResult = result.slice(0, 1500);
    for (const lifecyclePart of this._lifecycle.finishStep(finishReason)) {
      yield this._scopedToolEvent({ type: "tool-part", part: lifecyclePart }, executionScope);
    }
    const exitCode = /^Exit:\s*(-?\d+)/im.exec(result)?.[1];
    const answer = failed
      ? `Command finished with exit code ${exitCode ?? "unknown"}.`
      : `Command finished with exit code ${exitCode ?? "0"}.`;
    this._appendMessage({ role: "assistant", content: answer });
    this._finishLatency();
    yield { type: "stream", token: answer };
    yield { type: "stream-end" };
  }

  _buildContext() {
    const entry = this._frame();
    let context = entry.messages;
    if (entry.hasPlaceholders) {
      context = this._secretStore.resolveSerializable(
        context,
        this._activeRun?.runId,
        this._activeRun?.turnId,
      );
    }
    return context;
  }


};
