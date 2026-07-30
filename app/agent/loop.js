import { cleanInteractiveText } from "../../lib/interactive-text.js";
import { redactSecrets } from "../../lib/secrets.js";
import { createAssistantTextGuard, sanitizeAssistantIdentity } from "../../lib/assistant-text.js";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isObject, workspaceMetadata, INSPECTION_TOOLS, IDEMPOTENT_MUTATION_TOOLS, MAX_LOOP_RECOVERIES, sourceUrls, deterministicIdentityAnswer, extractPlan, normalizePlan, requiresPlan, fallbackPlan, extractInteractiveQuestion, toolSignature, publicToolArgs, repeatedToolCycle, cachedToolAnswer, requestMode, declaredSymbols, preservesImplementationStructure, prospectiveFileContent, shouldDeferToolCandidateProse, wantsFileCount, simpleFileListRequest, fileCountFromToolResult, resultFailed, isSteeringOutcome, legacyGuardOutcome, guardErrorOutcome, patchReview, toolMetadata, requestedSampleExtensions, needsFileMutation, needsDeletionMutation, clearWorkspaceRequest, isDeletionCommand, needsExecutionValidation, isValidationCommand, expectedPlanTools, mutationSatisfiesPlanItem, toolMatchesPlanItem, isInspectionCommand, mutatesWorkspace, streamDisposition } from "./helpers/task.js";
import { isProviderParseFailure, isShortContinuation, isNegativeContinuation, pendingActionState, offeredModificationContract, offersFollowUpAction, extractJsonCandidates, decodeXmlEntities, coerceTaggedArgument, extractTaggedToolCall, extractProseBeforeTool, LEGACY_PROTOCOL_HOLDBACK, MAX_PROSE_CONTINUATIONS, jsonCompletion, validateToolArguments, delimiterCount, proseLooksIncomplete, stripMarkdown, joinProseContinuation } from "./helpers/parser.js";
import { initializeAgentRequest, prepareProviderRetry, providerFailureContent, recoverableProviderFailure, rememberProviderFailure } from "./request-state.js";
import { createPublicActivityChannel } from "../public-activity.js";
export class LoopMethods {
  async *loop(input, signal, scope = {}) {
    await this._registryReady;
    const retryProvider = Boolean(scope.retryProvider);
    if (this._activeRun && !this._activeRun.finalized) {
      this._activeRun.cancelled = true;
      this._abortController?.abort(new Error("Superseded by a newer turn"));
    }
    const runId = scope.runId || randomUUID(), turnId = scope.turnId || randomUUID();
    const taskEpoch = retryProvider ? scope.taskEpoch ?? this._recoverableProviderRequest?.taskEpoch ?? this._taskEpoch
      : Math.max(this._taskEpoch + 1, Number(scope.taskEpoch) || 0);
    this._taskEpoch = taskEpoch;
    const run = { sessionId: this._sessionId, runId, turnId, taskEpoch, cancelled: false, finalized: false };
    this._activeRun = run;
    this._lifecycle.beginScope({ runId, turnId, taskEpoch });
    this._shellScheduler.beginRun(runId, turnId, taskEpoch, retryProvider);
    const isRunCurrent = () => this._activeRun === run, isRunActive = () => isRunCurrent() && !run.cancelled && !run.finalized;
    const scoped = event => ({ ...event, runId, turnId, taskEpoch });
    const finalizeRun = () => {
      if (!isRunCurrent() || run.finalized) return false;
      run.finalized = true;
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
      // Reset turn-scoped counters on new turn, preserve session and context
      this._usageTracker.resetTurn();
    }
    if (!retryProvider && Array.isArray(scope.approvedPlan?.steps)) {
      this._plan = scope.approvedPlan.steps.map(description => ({
        description: String(description),
        status: "pending",
      }));
      this._planIndex = 0;
      this._activeScope.currentPlan = this._plan.map(item => ({ ...item }));
      yield scoped({ type: "plan", items: this._plan.map(item => ({ ...item })) });
    }
    yield scoped({ type: "context-usage", usage: this.contextUsage() });
    const initialUsage = this.contextUsage();
    const initialProjectedRatio = initialUsage.contextLimitKnown
      ? initialUsage.projectedRequestTokens / initialUsage.contextLimit
      : null;
    if (initialProjectedRatio !== null && initialProjectedRatio < this._config.compactThreshold) {
      this._compactionThresholdCrossed = false;
    }
    if (
      this._messages.length > 2
      && initialProjectedRatio !== null
      && initialProjectedRatio >= this._config.compactThreshold
      && !this._compactionThresholdCrossed
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
      yield scoped({ type: "thinking", turn: this._turn, phase });
      if (!isRunActive()) return;
      if (this._compaction.status === "scheduled" && this._compactionActiveFor(run)) {
        const compactionId = this._compaction.compactionId;
        const originalMessages = this._messages;
        const originalSummary = this._summary;
        const originalRequestStartIndex = this._requestStartIndex;
        const revisionAtSchedule = this._historyRevision;
        const transition = status => {
          if (!isRunActive() || this._compaction.compactionId !== compactionId) return null;
          if (Date.now() - this._compaction.startedAt > 30_000) return null;
          this._compaction.status = status;
          return scoped({
            type: "compaction-state",
            status,
            compactionId,
            startedAt: this._compaction.startedAt,
            usage: this.contextUsage(),
          });
        };
        let failed = false;
        for (const status of ["preparing", "summarizing"]) {
          const event = transition(status);
          if (!event) { failed = true; break; }
          yield event;
        }
        const compacted = failed ? null : this._buildCompactedMessages(true);
        if (!compacted) failed = true;
        const committing = failed ? null : transition("committing");
        if (committing) {
          yield committing;
          if (
            isRunActive()
            && this._compaction.compactionId === compactionId
            && this._historyRevision === revisionAtSchedule
          ) {
            this._messages = compacted.messages;
            this._summary = compacted.summary;
            this._requestStartIndex = compacted.requestStartIndex;
            this._usageTracker.bumpHistoryRevision();
            this._historyRevision = this._usageTracker.historyRevision;
          } else {
            failed = true;
          }
        } else if (!failed) failed = true;
        const recounting = failed ? null : transition("recounting");
        if (recounting) yield recounting;
        if (failed || !isRunActive() || this._compaction.compactionId !== compactionId) {
          this._messages = originalMessages;
          this._summary = originalSummary;
          this._requestStartIndex = originalRequestStartIndex;
          this._compaction.status = "failed";
          yield scoped({ type: "compaction-state", status: "failed", compactionId });
          this._clearCompaction();
          yield scoped({ type: "error", content: "[×] Context compaction could not be completed." });
          if (finalizeRun()) return;
        }
        this._compaction.status = "completed";
        this._compaction.stableTokens = null;
        this._recordProgress();
        yield scoped({
          type: "compaction-state",
          status: "completed",
          compactionId,
          usage: this.contextUsage(),
        });
        this._clearCompaction();
      }
      let ctx = this._buildContext();
      let reply;
      let streamMode = "pending", streamTail = "";
      let streamStarted = false;
      let streamVisibleLength = 0;
      let finalError = null;
      let nativeToolStream = false;
      let typedProviderStream = false;
      const deferProse = Boolean(pendingProse);
      const requestModel = this._model;
      const maxAttempts = this._chatHandlesRetries || /(?:claude|anthropic)/i.test(String(requestModel)) ? 1 : 2;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const providerRequestId = randomUUID();
        let chatErr;
        let receivedAnyToken = false;
        const publicActivity = createPublicActivityChannel(run, value => this.redactSerializableForDisplay(value));
        const eventQueue = [];
        let eventResolve = null;
        const queueEvent = event => {
          if (!event || !isRunActive()) return;
          if (eventResolve) {
            const resolveEvent = eventResolve;
            eventResolve = null;
            resolveEvent(event);
          } else {
            eventQueue.push(event);
          }
        };
        const compatibilityGuard = createAssistantTextGuard();
        const onToken = token => {
          if (!isRunActive()) return;
          this._markLatency("providerFirstDelta");
          receivedAnyToken = true;
          const text = compatibilityGuard.push(token);
          if (text) queueEvent({ type: "text-delta", text, compatibility: true });
        };
        const onEvent = event => {
          if (!isRunActive()) return;
          if (event?.type === "usage") {
            this._usageTracker.record({ ...event, requestId: providerRequestId }, run);
            const reportedLimit = Number(event.contextLimit);
            if (Number.isFinite(reportedLimit) && reportedLimit > 0) {
              this._providerContextLimit = reportedLimit;
            }
            return;
          }
          typedProviderStream = true;
          if (["text-delta", "reasoning-delta", "tool-call-delta"].includes(event?.type)) {
            this._markLatency("providerFirstDelta");
            receivedAnyToken = true;
          }
          if (event?.type === "text-delta" && event.text) queueEvent(event);
          if (event?.type === "reasoning-delta" && event.text) queueEvent(event);
          if (event?.type === "tool-call-delta") nativeToolStream = true;
          for (const activity of publicActivity.accept(event)) queueEvent(activity);
        };
        const nativeTools = (await this._registry.definitions({
          model: requestModel, agent: this._agentProfile?.name, directory: this._workspace,
        })).map(tool => ({
          type: "function",
          function: {
            name: tool.name, description: tool.description || "",
            parameters: tool.parameters || { type: "object", properties: {} },
          },
        }));
        if (!isRunActive()) return;
        this._markLatency("requestDispatched");
        // Load model-specific settings from the settings store
        let temperature, topP, maxTokens;
        try {
          const mod = await import("../../config/model-settings.js");
          const settings = mod.resolveEffectiveSettings(requestModel);
          temperature = settings.temperature;
          topP = settings.topP;
          maxTokens = settings.maxOutputTokens;
          const caps = mod.resolveProviderCapabilities(requestModel);
          if (!caps.supportsTemperature) temperature = undefined;
          if (!caps.supportsTopP) topP = undefined;
          if (!caps.supportsMaxTokens) maxTokens = undefined;
        } catch {}
        const chatDone = this._chat(ctx, {
          model: requestModel, onToken, onEvent,
          signal: controller.signal,
          timeoutMs: this._config.providerTimeout,
          reasoningEffort: this._config.reasoningEffort,
          temperature,
          topP,
          maxTokens,
          tools: nativeTools, sessionId: this._sessionId, runId, turnId, taskEpoch,
          requestId: providerRequestId,
          streamPhase: phase,
        })
          .then(result => {
            if (!isRunActive()) return;
            if (typedProviderStream) {
              reply = sanitizeAssistantIdentity(result);
              return;
            }
            const completed = compatibilityGuard.finish(result);
            if (completed.output) {
              queueEvent({ type: "text-delta", text: completed.output, compatibility: true });
            }
            reply = completed.text;
          })
          .catch(error => {
            if (isRunCurrent()) chatErr = error;
          });
        const waitForEvent = () => new Promise(resolveEvent => { eventResolve = resolveEvent; });
        while (reply === undefined && chatErr === undefined) {
          const event = eventQueue.length > 0
            ? eventQueue.shift()
            : await Promise.race([waitForEvent(), chatDone.then(() => undefined)]);
          if (!isRunActive()) return;
          if (event === undefined) continue;
          if (event.type === "reasoning-delta") continue;
          if (event.type === "public-activity") { yield scoped(event); continue; }
          const token = event.text;
          if (typedProviderStream && !event.compatibility) {
            streamMode = "text";
            streamStarted = true;
            streamVisibleLength += token.length;
            this._markLatency("uiFirstText");
            yield scoped({ type: "stream", token });
            continue;
          }
          streamTail += token;
          const disposition = streamDisposition(streamTail);
          if (disposition === "structured" || streamMode === "pending") streamMode = disposition;
          if (streamMode === "text" && !deferProse && streamTail.length > LEGACY_PROTOCOL_HOLDBACK) {
            const visible = streamTail.slice(0, -LEGACY_PROTOCOL_HOLDBACK);
            streamTail = streamTail.slice(-LEGACY_PROTOCOL_HOLDBACK);
            streamStarted = true;
            streamVisibleLength += visible.length;
            this._markLatency("uiFirstText");
            yield scoped({ type: "stream", token: visible });
          }
        }
        while (eventQueue.length > 0) {
          const event = eventQueue.shift();
          if (event.type === "reasoning-delta") continue;
          if (event.type === "public-activity") { yield scoped(event); continue; }
          const token = event.text;
          if (typedProviderStream && !event.compatibility) {
            streamMode = "text";
            streamStarted = true;
            streamVisibleLength += token.length;
            this._markLatency("uiFirstText");
            yield scoped({ type: "stream", token });
            continue;
          }
          streamTail += token;
          const disposition = streamDisposition(streamTail);
          if (disposition === "structured" || streamMode === "pending") streamMode = disposition;
          if (streamMode === "text" && !deferProse && streamTail.length > LEGACY_PROTOCOL_HOLDBACK) {
            const visible = streamTail.slice(0, -LEGACY_PROTOCOL_HOLDBACK);
            streamTail = streamTail.slice(-LEGACY_PROTOCOL_HOLDBACK);
            streamStarted = true;
            streamVisibleLength += visible.length;
            this._markLatency("uiFirstText");
            yield scoped({ type: "stream", token: visible });
          }
        }
        await chatDone.catch(() => {});
        if (!isRunActive()) return;
        if (!chatErr) break;
        finalError = chatErr;
        if (streamStarted || receivedAnyToken || /request timed out|timeout|timed out/i.test(String(chatErr?.message || chatErr))) break;
        if (attempt < maxAttempts - 1) {
          if (!isRunActive()) break;
          try {
            await this._resetSession({ signal: controller.signal });
            if (!isRunActive()) break;
            reply = undefined;
            streamTail = "";
            streamMode = "pending";
            streamVisibleLength = 0;
            continue;
          } catch (resetError) {
            finalError = resetError;
          }
        }
        break;
      }
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
        this._debugToolRecovery("transport_failure", message);
        for (const lifecyclePart of this._lifecycle.finishStep("error")) {
          yield scoped({ type: "tool-part", part: lifecyclePart });
        }
        this._finishLatency();
        const recoverable = recoverableProviderFailure(finalError);
        if (recoverable) rememberProviderFailure(this, finalError, requestModel, phase);
        const content = recoverable
          ? providerFailureContent(finalError)
          : /request timed out|timeout|timed out/i.test(message)
          ? "Analysis timed out"
          : `Provider error: ${redactSecrets(message)}`;
        if (finalizeRun()) yield scoped({ type: "error", content, recoverable });
        return;
      }
      this._recoverableProviderRequest = null;
      this._transportFailures = 0;
      if (!reply || !reply.trim() || reply.trim() === "{}" || reply.trim() === "[]") {
        this._emptyResponses++;
        if (this._emptyResponses < 3) {
          if (streamStarted && streamMode === "text") yield scoped({ type: "stream-discard" });
          this._debugToolRecovery("empty_response", "Provider returned no usable content.");
          for (const lifecyclePart of this._lifecycle.finishStep("error")) {
            yield scoped({ type: "tool-part", part: lifecyclePart });
          }
          try {
            await this._resetSession({ signal: controller.signal });
            continue;
          } catch (resetError) {
            this._debugToolRecovery("empty_response_reset", resetError?.message || String(resetError));
          }
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
        if (validation) {
          parsed = { tool: null, error: validation.detail, kind: validation.kind, truncated: false };
          tool = null;
        }
      }
      if (parsed.error) {
        yield scoped({ type: "stream-discard" });
        this._debugToolRecovery(parsed.kind || "malformed_json", parsed.error);
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
        this._messages.push({ role: "assistant", content: this._secretStore.protect(reply, runId, turnId) });
        this._messages.push({ role: "user", content: `---TOOL ERROR: invalid_tool_call---\n${part.state.error}` });
        for (const lifecyclePart of this._lifecycle.finishStep("tool-error")) {
          yield scoped({ type: "tool-part", part: lifecyclePart });
        }
        this._invalidToolResponses = 0;
        continue;
      }
      this._invalidToolResponses = 0;
      if (!tool) {
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
        this._messages.push({ role: "assistant", content: this._secretStore.protect(visibleReply, runId, turnId) });
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
      const auxiliaryTool = ["todowrite", "think"].includes(tool.name);
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
      yield scoped({ type: "tool-call", tool: tool.name, args: { ...tool.args }, callId: tool.id });
      if (!isRunActive()) return;
      this._messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: tool.id,
          type: "function",
          function: { name: tool.name, arguments: JSON.stringify(this._secretStore.protectSerializable(publicToolArgs(tool.args), runId, turnId)) },
        }],
      });
      yield scoped({ type: "context-usage", usage: this.contextUsage() });
      const planTracker = auxiliaryTool ? null : yield* this._startPlanItem(run);
      let result;
      let part;
      let finishReason = "tool-calls";
      for await (const event of this._toolExecutor(run).execute(tool, { agent: this._agentProfile?.name })) {
        if (event.type === "execution-result") {
          part = event.part;
          result = event.result;
          finishReason = event.finishReason;
          tool.args = event.call.args;
          tool.id = event.call.id;
        } else if (event.type === "tool-result") {
        } else {
          yield event;
        }
      }
      if (!isRunActive()) return;
      if (!part) continue;
      if (tool.name === "todowrite" && part.state.status === "completed") {
        const todos = Array.isArray(part.state.metadata?.todos) ? part.state.metadata.todos : [];
        this._plan = todos.map(todo => ({
          description: todo.content,
          status: todo.status === "completed" ? "done" : todo.status === "in_progress" ? "running" : "pending",
        }));
        const nextPlanIndex = this._plan.findIndex(item => item.status !== "done");
        this._planIndex = nextPlanIndex < 0 ? this._plan.length : nextPlanIndex;
        this._activeScope.currentPlan = this._plan.map(item => ({ ...item }));
        yield scoped({ type: "plan", items: this._plan.map(item => ({ ...item })) });
      }
      const protectedResult = this._secretStore.protect(result, runId, turnId);
      result = this._secretStore.redact(protectedResult);
      this._rememberToolOutcome(tool, protectedResult);
      if (["web", "webfetch", "websearch", "repo"].includes(tool.name)) {
        this._researchSources = [...new Set([...this._researchSources, ...sourceUrls(result)])].slice(0, 20);
      }
      const metadata = toolMetadata(tool, result);
      yield scoped({
        type: "tool-result",
        tool: tool.name,
        result,
        metadata,
        callId: part.callId,
        failed: part.state.status === "error",
      });
      this._toolEvidence.push({
        tool: tool.name,
        args: { ...tool.args },
        result,
        failed: resultFailed(result),
        metadata,
      });
      if (this._executionPolicy) {
        this._executionPolicy.record(tool.name, tool.args, result, part.state.status === "error");
      }
      this._lastToolResult = result;
      this._activeTask.lastToolResult = result.slice(0, 1500);
      this._activeTask.pendingProblem = part.state.status === "error" ? result.slice(0, 500) : "";
      this._lastToolIsRead = ["read", "glob", "grep"].includes(tool.name);
      this._lastToolWasExecuted = true;
      if (tool.name === "write") this._totalWrites++;
      this._messages.push({
        role: "tool",
        tool_call_id: part.callId,
        name: tool.name,
        content: protectedResult,
      });
      yield scoped({ type: "context-usage", usage: this.contextUsage() });
      // Track repeated inspection tools for no-progress detection
      if (["read", "glob", "grep"].includes(tool.name)) {
        const sig = `${tool.name}:${JSON.stringify(tool.args)}`;
        if (sig === this._progress.lastReadSignature || sig === this._progress.lastSearchSignature) {
          if (tool.name === "read") this._progress.repeatedReads++;
          else this._progress.repeatedSearches++;
        } else {
          if (tool.name === "read") {
            this._progress.repeatedReads = 0;
            this._progress.lastReadSignature = sig;
          } else {
            this._progress.repeatedSearches = 0;
            this._progress.lastSearchSignature = sig;
          }
        }
      } else {
        // Non-inspection tool execution counts as progress
        this._progress.repeatedSearches = 0;
        this._progress.repeatedReads = 0;
      }
      if (this._progress.repeatedSearches > 10 || this._progress.repeatedReads > 10) {
        // Repeated identical searches/reads — no progress
        this._finishLatency();
        if (finalizeRun()) {
          yield scoped({ type: "error", content: "No progress: repeated identical searches without meaningful change." });
        }
        return;
      }
      const usage = this.contextUsage();
      const projectedRatio = usage.contextLimitKnown
        ? usage.projectedRequestTokens / usage.contextLimit
        : null;
      if (projectedRatio !== null && projectedRatio < this._config.compactThreshold) {
        this._compactionThresholdCrossed = false;
      }
      if (
        projectedRatio !== null
        && projectedRatio >= this._config.compactThreshold
        && !this._compactionThresholdCrossed
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
      for (const lifecyclePart of this._lifecycle.finishStep(finishReason)) {
        yield scoped({ type: "tool-part", part: lifecyclePart });
      }
      yield* this._finishPlanItem(planTracker, part.state.status === "completed" && !resultFailed(result), run);
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
