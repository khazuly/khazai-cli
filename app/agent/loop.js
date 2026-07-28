import { cleanInteractiveText } from "../../lib/interactive-text.js";
import { redactSecrets } from "../../lib/secrets.js";
import { createAssistantTextGuard, sanitizeAssistantIdentity } from "../../lib/assistant-text.js";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isObject, workspaceMetadata, PARALLEL_READ_ONLY_TOOLS, INSPECTION_TOOLS, IDEMPOTENT_MUTATION_TOOLS, MAX_LOOP_RECOVERIES, sourceUrls, deterministicIdentityAnswer, extractPlan, normalizePlan, requiresPlan, fallbackPlan, extractInteractiveQuestion, toolSignature, publicToolArgs, repeatedToolCycle, cachedToolAnswer, requestMode, declaredSymbols, preservesImplementationStructure, prospectiveFileContent, shouldDeferToolCandidateProse, wantsFileCount, simpleFileListRequest, fileCountFromToolResult, resultFailed, isSteeringOutcome, legacyGuardOutcome, guardErrorOutcome, patchReview, toolMetadata, requestedSampleExtensions, needsFileMutation, needsDeletionMutation, clearWorkspaceRequest, isDeletionCommand, needsExecutionValidation, isValidationCommand, expectedPlanTools, mutationSatisfiesPlanItem, toolMatchesPlanItem, isInspectionCommand, mutatesWorkspace, streamDisposition } from "./helpers/task.js";
import { isProviderParseFailure, isShortContinuation, isNegativeContinuation, pendingActionState, offeredModificationContract, offersFollowUpAction, extractJsonCandidates, decodeXmlEntities, coerceTaggedArgument, extractTaggedToolCall, extractProseBeforeTool, LEGACY_PROTOCOL_HOLDBACK, MAX_PROSE_CONTINUATIONS, jsonCompletion, validateToolArguments, delimiterCount, proseLooksIncomplete, stripMarkdown, joinProseContinuation } from "./helpers/parser.js";
import { initializeAgentRequest, prepareProviderRetry, providerFailureContent, recoverableProviderFailure, rememberProviderFailure } from "./request-state.js";
export class LoopMethods {
  async *loop(input, signal, scope = {}) {
    await this._registryReady;
    const retryProvider = Boolean(scope.retryProvider);
    if (this._activeRun && !this._activeRun.finalized) {
      this._activeRun.cancelled = true;
      this._abortController?.abort(new Error("Superseded by a newer turn"));
    }
    const runId = scope.runId || randomUUID();
    const turnId = scope.turnId || randomUUID();
    const run = { runId, turnId, cancelled: false, finalized: false };
    this._activeRun = run;
    this._shellScheduler.beginRun(runId, turnId, retryProvider);
    const isRunCurrent = () => this._activeRun === run;
    const isRunActive = () => isRunCurrent() && !run.cancelled && !run.finalized;
    const scoped = event => ({ ...event, runId, turnId });
    const finalizeRun = () => {
      if (!isRunCurrent() || run.finalized) return false;
      run.finalized = true;
      return true;
    };
    this._abortController = new AbortController();
    if (signal?.aborted) this._abortController.abort();
    else signal?.addEventListener("abort", () => this._abortController.abort(), { once: true });
    try {
    this._latency = { inputReceived: performance.now() };
    this._compactMessages();
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
      prepareProviderRetry(this);
    } else {
      await initializeAgentRequest(this, requestInput.protectedContent, signal, requestInput.rawContent);
    }
    let pendingProse = "";
    let proseContinuations = 0;
    while (this._turn < this._config.maxTurns) {
      if (this._aborted || signal?.aborted) {
        if (finalizeRun()) yield scoped({ type: "answer", content: "The task was cancelled." });
        return;
      }
      this._turn++;
      this._stepBlocked = false;
      const snapshotPart = this._lifecycle.startStep();
      if (snapshotPart) yield scoped({ type: "tool-part", part: snapshotPart });
      const phase = this._lastToolWasExecuted
        ? "continuation"
        : this._planningPhase || this._taskContract?.category === "MODIFICATION"
          ? "implementation"
          : "context";
      yield scoped({ type: "thinking", turn: this._turn, phase });

      const ctx = this._buildContext();
      let reply;
      let streamMode = "pending";
      let streamTail = "";
      let streamStarted = false;
      let streamVisibleLength = 0;
      let finalError = null;
      let nativeToolStream = false;
      let typedProviderStream = false;
      const deferProse = Boolean(pendingProse);
      const requestModel = this._model;
      const maxAttempts = this._chatHandlesRetries || /(?:claude|anthropic)/i.test(String(requestModel)) ? 1 : 2;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        let chatErr;
        let receivedAnyToken = false;
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
          typedProviderStream = true;
          if (["text-delta", "reasoning-delta", "tool-call-delta"].includes(event?.type)) {
            this._markLatency("providerFirstDelta");
            receivedAnyToken = true;
          }
          if (event?.type === "text-delta" && event.text) queueEvent(event);
          if (event?.type === "reasoning-delta" && event.text) queueEvent(event);
          if (event?.type === "tool-call-delta") nativeToolStream = true;
        };
        const nativeTools = (await this._registry.definitions({
          model: requestModel,
          agent: this._agentProfile?.name,
          directory: this._workspace,
        })).map(tool => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description || "",
            parameters: tool.parameters || { type: "object", properties: {} },
          },
        }));
        this._markLatency("requestDispatched");
        const chatDone = this._chat(ctx, {
          model: requestModel,
          onToken,
          onEvent,
          signal: this._abortController.signal,
          timeoutMs: this._config.providerTimeout,
          reasoningEffort: this._config.reasoningEffort,
          tools: nativeTools,
          sessionId: this._sessionId,
          runId,
          turnId,
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
          if (event === undefined) continue;
          if (event.type === "reasoning-delta") {
            yield scoped({ type: "reasoning", token: event.text });
            continue;
          }
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
          if (event.type === "reasoning-delta") {
            yield scoped({ type: "reasoning", token: event.text });
            continue;
          }
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
        if (!chatErr) break;

        finalError = chatErr;
        if (streamStarted || receivedAnyToken || /request timed out|timeout|timed out/i.test(String(chatErr?.message || chatErr))) break;
        if (attempt < maxAttempts - 1) {
          if (!isRunActive()) break;
          try {
            await this._resetSession({ signal });
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
        this._debugToolRecovery("transport_failure", finalError?.message || String(finalError));
        for (const lifecyclePart of this._lifecycle.finishStep("error")) {
          yield scoped({ type: "tool-part", part: lifecyclePart });
        }
        this._finishLatency();
        const message = finalError?.message || String(finalError);
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
            await this._resetSession({ signal });
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
      if (
        parsed.tools?.length > 1
        && parsed.tools.every(candidate => PARALLEL_READ_ONLY_TOOLS.has(this._normalizeTool(candidate).name))
      ) {
        yield* commitProseBeforeTool(this._normalizeTool(parsed.tools[0]));
        for await (const event of this._runReadOnlyBatch(parsed.tools)) yield event;
        if (this._loopRecoveryExhausted) {
          const answer = this._boundedLoopRecoveryAnswer();
          yield scoped({ type: "stream", token: answer });
          if (finalizeRun()) yield scoped({ type: "stream-end" });
          return;
        }
        if (this._stepBlocked) return;
        continue;
      }
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
        this._clearPendingAction();
        for (const lifecyclePart of this._lifecycle.finishStep("stop")) {
          yield scoped({ type: "tool-part", part: lifecyclePart });
        }
        this._finishLatency();
        if (finalizeRun()) yield scoped({ type: "stream-end" });
        return;
      }
      yield* commitProseBeforeTool(tool);
      const auxiliaryTool = tool.name === "todowrite";
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
      this._messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: tool.id,
          type: "function",
          function: { name: tool.name, arguments: JSON.stringify(this._secretStore.protectSerializable(publicToolArgs(tool.args), runId, turnId)) },
        }],
      });
      const planTracker = auxiliaryTool ? null : yield* this._startPlanItem();
      let result;
      let part;
      let finishReason = "tool-calls";
      for await (const event of this._toolExecutor().execute(tool, { agent: this._agentProfile?.name })) {
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
      if (!part) continue;
      if (tool.name === "todowrite" && part.state.status === "completed") {
        const todos = Array.isArray(part.state.metadata?.todos) ? part.state.metadata.todos : [];
        this._plan = todos.map(todo => ({
          description: todo.content,
          status: todo.status === "completed" ? "done" : todo.status === "in_progress" ? "running" : "pending",
        }));
        const nextPlanIndex = this._plan.findIndex(item => item.status !== "done");
        this._planIndex = nextPlanIndex < 0 ? this._plan.length : nextPlanIndex;
        yield { type: "plan", items: this._plan.map(item => ({ ...item })) };
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
      for (const lifecyclePart of this._lifecycle.finishStep(finishReason)) {
        yield scoped({ type: "tool-part", part: lifecyclePart });
      }
      yield* this._finishPlanItem(planTracker, part.state.status === "completed" && !resultFailed(result));
    }
    this._finishLatency();
    if (finalizeRun()) {
      yield scoped({ type: "error", content: `Maximum step count reached (${this._config.maxTurns}).` });
    }
    } finally {
      if (!this._recoverableProviderRequest) this._secretStore.clear(runId, turnId);
    }
  }
};
