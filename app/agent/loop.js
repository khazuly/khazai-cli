import { redactSecrets } from "../../lib/secrets.js";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { publicToolArgs } from "./helpers/task.js";
import { extractProseBeforeTool, validateToolArguments, joinProseContinuation } from "./helpers/parser.js";
import { initializeAgentRequest, prepareProviderRetry, providerFailureContent, recoverableProviderFailure, rememberProviderFailure } from "./request-state.js";
import { requiredMcpServer, usedMcpServer } from "./mcp-policy.js";
import { runScheduledCompaction } from "./loop-compaction.js";
import { requestProviderTurn } from "./loop-provider.js";
import { executeAgentTool } from "./loop-tool.js";
export class LoopMethods {
  async *loop(input, signal, scope = {}) {
    await this._registryReady;
    const retryProvider = Boolean(scope.retryProvider);
    if (this._activeRun && !this._activeRun.finalized) {
      this._activeRun.cancelled = true;
      this._abortController?.abort(new Error("Superseded by a newer turn"));
      this._clearCompactionIfStale(this._activeRun);
    }
    const runId = scope.runId || randomUUID(), turnId = scope.turnId || randomUUID();
    const taskEpoch = retryProvider ? scope.taskEpoch ?? this._recoverableProviderRequest?.taskEpoch ?? this._taskEpoch
      : Math.max(this._taskEpoch + 1, Number(scope.taskEpoch) || 0);
    this._taskEpoch = taskEpoch;
    const mode = scope.mode === "plan" || scope.mode === "build" ? scope.mode : this.mode();
    const run = { sessionId: this._sessionId, runId, turnId, taskEpoch, mode, cancelled: false, finalized: false };
    this._activeRun = run;
    this._modeState = { sessionId: this._sessionId, runId, turnId, taskEpoch, mode };
    this._lifecycle.beginScope({ runId, turnId, taskEpoch });
    this._shellScheduler.beginRun(runId, turnId, taskEpoch, retryProvider);
    const isRunCurrent = () => this._activeRun === run, isRunActive = () => isRunCurrent() && !run.cancelled && !run.finalized;
    const scoped = event => ({ ...event, runId, turnId, taskEpoch });
    const finalizeRun = () => {
      if (!isRunCurrent() || run.finalized) return false;
      run.finalized = true;
      if (this._durableRun?.runId === run.runId || this._durableRun?.turnId === run.turnId) {
        this._durableRun = {
          ...this._durableRun,
          status: run.cancelled ? "interrupted" : "completed",
          phase: run.cancelled ? "interrupted" : "completed",
          updatedAt: new Date().toISOString(),
        };
      }
      this._clearCompactionIfStale(run);
      return true;
    };
    const controller = new AbortController();
    run.controller = controller;
    this._abortController = controller;
    const abortRun = () => controller.abort(signal?.reason);
    if (signal?.aborted) abortRun();
    else signal?.addEventListener("abort", abortRun, { once: true });
    try {
    this._latency = { inputReceived: performance.now() };
    if (!retryProvider) this._mcpCorrectionUsed = false;
    const requestInput = retryProvider ? null : this._secretStore.capture(input, runId, turnId);
    if (!retryProvider && requestInput.rawContent.trimStart().startsWith("!")) {
      yield* this._runShellShortcut(requestInput.rawContent.trimStart());
      return;
    }
    if (retryProvider) {
      if (!this.hasRecoverableProviderRequest()) {
        if (finalizeRun()) {
          yield scoped({ type: "error", content: "No recoverable model request is available." });
        }
        return;
      }
      this._secretStore.rebind(runId, turnId);
      prepareProviderRetry(this, run);
    } else {
      const initialized = await initializeAgentRequest(
        this, requestInput.protectedContent, controller.signal, requestInput.rawContent, run,
      );
      if (!initialized || !isRunActive()) return;

      this._usageTracker.resetTurn();
    }
    if (!retryProvider && Array.isArray(scope.approvedPlan?.steps)) {
      const plan = this._definePlan(
        scope.approvedPlan.steps.map(description => ({ content: String(description), status: "pending" })),
        run,
        scope.approvedPlan.planId,
      );
      yield scoped({
        type: "plan",
        items: plan.map(item => ({ ...item })),
        planId: scope.approvedPlan.planId,
        currentStepId: this._currentStepId,
        revision: this._planRevision,
        status: this._planStatus,
      });
    }
    yield scoped({ type: "context-usage", usage: this.contextUsage() });
    const initialUsage = this.contextUsage();
    const initialProjectedRatio = initialUsage.contextLimitKnown
      ? initialUsage.projectedRequestTokens / initialUsage.contextLimit
      : null;
    const initialUsableRatio = initialUsage.usableContextTokens
      ? initialUsage.projectedRequestTokens / initialUsage.usableContextTokens
      : null;
    if (initialUsableRatio !== null && initialUsableRatio < this._config.compactThreshold) {
      this._compactionThresholdCrossed = false;
    }
    const emergencyThreshold = Number(this._config.emergencyCompactThreshold) || 0.92;
    const shouldScheduleCompaction = this._messages.length > 2 && !this._compactionThresholdCrossed;
    if (
      shouldScheduleCompaction
      && initialProjectedRatio >= emergencyThreshold
      && this._scheduleCompaction(run, "emergency")
    ) {
      this._compactionThresholdCrossed = true;
      yield scoped({
        type: "compaction-state",
        status: "scheduled",
        compactionId: this._compaction.compactionId,
        startedAt: this._compaction.startedAt,
        usage: this.contextUsage(),
      });
    } else if (
      shouldScheduleCompaction
      && this._shouldCompactUsage(initialUsage)
      && this._scheduleCompaction(run)
    ) {
      this._compactionThresholdCrossed = true;
      yield scoped({
        type: "compaction-state",
        status: "scheduled",
        compactionId: this._compaction.compactionId,
        startedAt: this._compaction.startedAt,
        usage: this.contextUsage(),
      });
    }
    let pendingProse = "", proseContinuations = 0;
    while (this._turn < this._config.maxTurns) {
      if (!isRunActive() || this._aborted || signal?.aborted) {
        if (finalizeRun()) yield scoped({ type: "answer", content: "The task was cancelled." });
        return;
      }
      this._turn++;
      this._stepBlocked = false;
      const snapshotPart = this._lifecycle.startStep();
      if (snapshotPart) yield scoped({ type: "tool-part", part: snapshotPart });
      if (!isRunActive()) return;
      const phase = this._lastToolWasExecuted
        ? "continuation"
        : this._planningPhase || this._taskContract?.category === "MODIFICATION"
          ? "implementation"
          : "context";
      this._updateDurableRun({ phase });
      yield scoped({ type: "thinking", turn: this._turn, phase });
      if (!isRunActive()) return;
      if (this._compaction.status === "scheduled" && this._compactionActiveFor(run)) {
        const compacted = yield* runScheduledCompaction.call(this, run, { isRunActive, scoped, finalizeRun });
        if (!compacted) return;
      }
      const prepStart = performance.now();
      const requestModel = this._model;
      const [ctx, nativeTools] = await Promise.all([
        Promise.resolve().then(() => this._buildContext()),
        this._toolSchemas(requestModel, this._agentProfile?.name),
      ]);
      this._markLatencyDuration("historyPreparationMs", prepStart);
      this._latency.instructionLoadingMs = this._instructionService.lastLoadMs;
      this._latency.modeSwitchMs ??= this._lastModeSwitchMs || 0;
      this._lastModeSwitchMs = 0;
      const instructionWarning = this._instructionService.takeWarning();
      if (instructionWarning) yield scoped({ type: "answer", content: `[!] ${instructionWarning}` });
      const frameStats = this._lastFrameEntry?.stats || null;
      if (frameStats) {
        this._latency.messageValidationMs = frameStats.validationMs;
        this._latency.tokenCountingMs = frameStats.tokenCountingMs;
        this._latency.messageCount = frameStats.messageCount;
        this._latency.serializedPayloadBytes = frameStats.payloadBytes;
      }
      this._latency.currentContextTokens = this._lastFrameEntry?.jsonTokens ?? null;
      this._latency.headTokens = this._lastFrameEntry?.headTokens ?? null;
      const frameTokens = this._lastFrameEntry?.jsonTokens || 0;
      const contextLimitForPhase = this._applyEffectiveSettings().contextLimit || 0;
      if (
        frameTokens >= 12_000
        || (contextLimitForPhase > 0 && frameTokens >= contextLimitForPhase * 0.5)
      ) {
        yield scoped({ type: "phase", label: "Preparing large context" });
      }
      if (!isRunActive()) return;
      const maxAttempts = this._chatHandlesRetries ? 1 : 2;
      if (!isRunActive()) return;
      const compactionCheckStart = performance.now();
      let projected = null;
      if (this._compaction.status !== "scheduled" && !this._compactionThresholdCrossed) {
        projected = await this._projectProviderPayload(ctx, nativeTools, requestModel);
        this._markLatencyDuration("compactionCheckMs", compactionCheckStart);
        if (
          projected.contextLimit
          && projected.ratio !== null
          && projected.ratio >= emergencyThreshold
          && this._scheduleCompaction(run, "emergency")
        ) {
          this._compactionThresholdCrossed = true;
          yield scoped({
            type: "compaction-state",
            status: "scheduled",
            compactionId: this._compaction.compactionId,
            startedAt: this._compaction.startedAt,
            usage: this.contextUsage(),
          });
          continue;
        }
        if (
          (projected.tokens >= (this._compactionTokenLimit() || Infinity)
            || (projected.usableRatio !== null && projected.usableRatio >= this._config.compactThreshold))
          && this._scheduleCompaction(run)
        ) {
          this._compactionThresholdCrossed = true;
          yield scoped({
            type: "compaction-state",
            status: "scheduled",
            compactionId: this._compaction.compactionId,
            startedAt: this._compaction.startedAt,
            usage: this.contextUsage(),
          });
          continue;
        }
      } else {
        this._markLatencyDuration("compactionCheckMs", compactionCheckStart);
      }
      const providerTurn = yield* requestProviderTurn.call(this, {
        ctx, nativeTools, requestModel, controller, run, pendingProse, maxAttempts, isRunActive,
        isRunCurrent, scoped, runId, turnId, taskEpoch, retryProvider, phase, projected,
      });
      if (!providerTurn || !isRunActive()) {
        finalizeRun();
        return;
      }
      let {
        reply, streamMode, streamTail, streamStarted, streamVisibleLength, finalError,
        nativeToolStream, typedProviderStream,
      } = providerTurn;
      if (finalError && reply === undefined) {
        if (!isRunActive()) {
          finalizeRun();
          return;
        }
        if (streamStarted && streamMode === "text") {
          yield scoped({ type: "stream-discard" });
        }
        const message = finalError?.message || String(finalError);
        const isContextLength = /context\s*length|context_length_exceeded|maximum\s*context|token\s*limit/i.test(message);
        if (
          isContextLength
          && this._contextErrorCompactedRunId !== run.runId
          && this._scheduleCompaction(run, "context-error")
        ) {
          yield scoped({
            type: "compaction-state",
            status: "scheduled",
            compactionId: this._compaction.compactionId,
            startedAt: this._compaction.startedAt,
            usage: this.contextUsage(),
          });
          continue;
        }
        for (const lifecyclePart of this._lifecycle.finishStep("error")) {
          yield scoped({ type: "tool-part", part: lifecyclePart });
        }
        this._finishLatency();
        const recoverable = recoverableProviderFailure(finalError);
        if (recoverable) rememberProviderFailure(this, finalError, requestModel, phase);
        const failedModel = finalError?.resolvedModel || requestModel;
        const content = recoverable
          ? providerFailureContent(finalError, failedModel)
          : /request timed out|timeout|timed out/i.test(message)
          ? "Analysis timed out"
          : finalError?.failureClass || finalError?.status
            ? providerFailureContent(finalError, failedModel)
            : `Provider error: ${this.redactForDisplay(redactSecrets(message))}`;
        if (finalizeRun()) yield scoped({ type: "error", content, recoverable });
        return;
      }
      this._recoverableProviderRequest = null;
      this._transportFailures = 0;
      if (!reply || !reply.trim() || reply.trim() === "{}" || reply.trim() === "[]") {
        this._emptyResponses++;
        if (this._emptyResponses < 3) {
          if (streamStarted && streamMode === "text") yield scoped({ type: "stream-discard" });
          for (const lifecyclePart of this._lifecycle.finishStep("error")) {
            yield scoped({ type: "tool-part", part: lifecyclePart });
          }
          let resetFailed = false;
          try {
            if (this._resetSession) await this._resetSession({ signal: controller.signal });
          } catch {
            resetFailed = true;
          }
          if (!resetFailed) continue;
        }
        for (const lifecyclePart of this._lifecycle.finishStep("error")) {
          yield scoped({ type: "tool-part", part: lifecyclePart });
        }
        this._finishLatency();
        if (finalizeRun()) {
          yield scoped({ type: "error", content: "Provider returned an empty response." });
        }
        return;
      }
      this._emptyResponses = 0;
      let parsed = nativeToolStream ? this._extractNativeTool(reply) : this._extractTool(reply);
      const commitProseBeforeTool = function* (tool) {
        if (!typedProviderStream) {
          const prose = extractProseBeforeTool(reply, tool);
          const remaining = prose.slice(Math.min(streamVisibleLength, prose.length));
          if (remaining) yield scoped({ type: "stream", token: remaining });
        }
        if (streamStarted || !typedProviderStream) yield scoped({ type: "stream-commit" });
      };
      if (parsed.tools?.length > 1) {
        yield* commitProseBeforeTool(this._normalizeTool(parsed.tools[0]));
        for await (const event of this._runSequentialBatch(parsed.tools)) yield event;
        if (this._loopRecoveryExhausted) {
          const answer = this._boundedLoopRecoveryAnswer();
          yield scoped({ type: "stream", token: answer });
          if (finalizeRun()) yield scoped({ type: "stream-end" });
          return;
        }
        continue;
      }
      if (parsed.tools?.length) parsed = { ...parsed, tool: parsed.tools[0], tools: undefined };
      let tool = parsed.tool ? this._normalizeTool(parsed.tool) : null;
      if (tool) {
        const validation = validateToolArguments(tool, this._registry);
        if (validation && validation.kind !== "unknown_tool") {
          parsed = { tool: null, error: validation.detail, kind: validation.kind, truncated: false };
          tool = null;
        }
      }
      if (parsed.error) {
        yield scoped({ type: "stream-discard" });
        const part = this._lifecycle.pending({
          callId: randomUUID(),
          tool: "invalid_tool_call",
          input: { kind: parsed.kind || "malformed_json" },
        });
        this._lifecycle.running(part);
        this._lifecycle.failed(part, parsed.error);
        yield scoped({ type: "tool-part", part: { ...part } });
        yield scoped({
          type: "tool-result",
          tool: "invalid_tool_call",
          result: part.state.error,
          callId: part.callId,
          failed: true,
        });
        this._appendMessage({ role: "assistant", content: this._secretStore.protect(reply, runId, turnId) });
        this._appendMessage({ role: "user", content: `---TOOL ERROR: invalid_tool_call---\n${part.state.error}` });
        for (const lifecyclePart of this._lifecycle.finishStep("tool-error")) {
          yield scoped({ type: "tool-part", part: lifecyclePart });
        }
        this._invalidToolResponses = 0;
        continue;
      }
      this._invalidToolResponses = 0;
      if (!tool) {
        const requiredServer = requiredMcpServer(
          this._registry,
          this._currentRequest,
          this._instructionService.getSystemPromptBlock(),
        );
        if (requiredServer && !usedMcpServer(this._registry, this._toolEvidence, requiredServer)) {
          if (!this._mcpCorrectionUsed) {
            this._mcpCorrectionUsed = true;
            if (streamStarted || streamVisibleLength > 0) yield scoped({ type: "stream-discard" });
            this._appendMessage({
              role: "system",
              content: "MCP CORRECTION: Use the required MCP tool before answering. Do not claim results you have not retrieved.",
            });
            continue;
          }
          const failure = `[×] Required MCP server ${requiredServer} was not used.`;
          this._appendMessage({ role: "assistant", content: failure });
          this._finishLatency();
          if (finalizeRun()) yield scoped({ type: "stream", token: failure });
          if (run.finalized) yield scoped({ type: "stream-end" });
          return;
        }
        let visibleReply = pendingProse ? joinProseContinuation(pendingProse, reply) : reply;
        const displayReply = visibleReply;
        if (pendingProse) {
          this._markLatency("uiFirstText");
          yield scoped({ type: "stream", token: displayReply });
        } else if (streamMode === "text") {
          if (streamTail) {
            this._markLatency("uiFirstText");
            yield scoped({ type: "stream", token: streamTail });
          }
        } else {
          const remaining = reply.slice(streamVisibleLength);
          if (remaining) {
            this._markLatency("uiFirstText");
            yield scoped({ type: "stream", token: remaining });
          }
        }
        this._appendMessage({ role: "assistant", content: this._secretStore.protect(visibleReply, runId, turnId) });
        yield scoped({ type: "context-usage", usage: this.contextUsage() });
        this._clearPendingAction();
        for (const lifecyclePart of this._lifecycle.finishStep("stop")) {
          yield scoped({ type: "tool-part", part: lifecyclePart });
        }
        this._finishLatency();
        if (finalizeRun()) yield scoped({ type: "stream-end" });
        return;
      }
      yield* commitProseBeforeTool(tool);
      if (!isRunActive()) return;
      const registeredTool = this._registry.get(tool.name);
      const auxiliaryTool = !registeredTool || ["todowrite", "think"].includes(tool.name);
      tool.id ||= randomUUID();
      const loopRecovery = tool.name === "bash" ? this._shellScheduler.reserve(tool) : this._toolLoopRecovery(tool);
      if (loopRecovery) {
        if (loopRecovery.result) {
          this._recordShellReuse(tool, loopRecovery);
          if (loopRecovery.terminal) {
            const answer = this._finalizeShellBlocker(loopRecovery.result);
            yield scoped({ type: "stream", token: answer });
            if (finalizeRun()) yield scoped({ type: "stream-end" });
            return;
          }
          continue;
        }
        this._lifecycle.finishStep("tool-calls");
        if (loopRecovery.exhausted) {
          const answer = this._boundedLoopRecoveryAnswer();
          yield scoped({ type: "stream", token: answer });
          if (finalizeRun()) yield scoped({ type: "stream-end" });
          return;
        }
        continue;
      }
      if (registeredTool) {
        yield scoped({ type: "tool-call", tool: tool.name, args: { ...tool.args }, callId: tool.id });
      }
      if (!isRunActive()) return;
      this._appendMessage({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: tool.id,
          type: "function",
          function: { name: tool.name, arguments: JSON.stringify(this._secretStore.protectSerializable(publicToolArgs(tool.args), runId, turnId)) },
        }],
      });
      yield scoped({ type: "context-usage", usage: this.contextUsage() });
      const toolOutcome = yield* executeAgentTool.call(this, {
        tool, run, runId, turnId, auxiliaryTool, scoped, isRunActive, finalizeRun, emergencyThreshold,
      });
      if (toolOutcome === "stop") return;
      continue;
    }
    this._finishLatency();
    if (finalizeRun()) {
      yield scoped({ type: "error", content: `Maximum step count reached (${this._config.maxTurns}).` });
    }
    } finally {
      signal?.removeEventListener("abort", abortRun);
      if (!this._recoverableProviderRequest) this._secretStore.clear(runId, turnId);
    }
  }
};
