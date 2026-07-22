import { cleanInteractiveText } from "../../lib/interactive-text.js";
import { ExecutionPolicy } from "../execution-policy.js";
import { redactSecrets, extractCredential } from "../../lib/secrets.js";
import { createAssistantTextGuard, sanitizeAssistantIdentity } from "../../lib/assistant-text.js";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isObject, workspaceMetadata, PARALLEL_READ_ONLY_TOOLS, INSPECTION_TOOLS, IDEMPOTENT_MUTATION_TOOLS, MAX_LOOP_RECOVERIES, sourceUrls, deterministicIdentityAnswer, extractPlan, normalizePlan, requiresPlan, fallbackPlan, extractInteractiveQuestion, toolSignature, publicToolArgs, repeatedToolCycle, cachedToolAnswer, requestMode, declaredSymbols, preservesImplementationStructure, prospectiveFileContent, shouldDeferToolCandidateProse, wantsFileCount, simpleFileListRequest, fileCountFromToolResult, resultFailed, isSteeringOutcome, legacyGuardOutcome, guardErrorOutcome, patchReview, toolMetadata, requestedSampleExtensions, needsFileMutation, needsDeletionMutation, clearWorkspaceRequest, isDeletionCommand, needsExecutionValidation, isValidationCommand, expectedPlanTools, mutationSatisfiesPlanItem, toolMatchesPlanItem, isInspectionCommand, mutatesWorkspace, streamDisposition } from "./helpers/task.js";
import { isProviderParseFailure, isShortContinuation, isNegativeContinuation, pendingActionState, offeredModificationContract, offersFollowUpAction, taskState, extractJsonCandidates, decodeXmlEntities, coerceTaggedArgument, extractTaggedToolCall, extractProseBeforeTool, LEGACY_PROTOCOL_HOLDBACK, MAX_PROSE_CONTINUATIONS, jsonCompletion, validateToolArguments, delimiterCount, proseLooksIncomplete, stripMarkdown, joinProseContinuation } from "./helpers/parser.js";

export class LoopMethods {
  async *loop(input, signal) {
    await this._registryReady;
    this._abortController = new AbortController();
    if (signal?.aborted) this._abortController.abort();
    else signal?.addEventListener("abort", () => this._abortController.abort(), { once: true });
    this._latency = { inputReceived: performance.now() };
    this._compactMessages();
    const safeInput = redactSecrets(input);
    if (safeInput.trimStart().startsWith("!")) {
      yield* this._runShellShortcut(safeInput.trimStart());
      return;
    }
    this._messages.push({ role: "user", content: safeInput });
    this._requestStartIndex = this._messages.length - 1;
    this._currentRequest = safeInput;
    this._pendingAction = null;
    this._pendingGitPush = null;
    this._requestMode = "neutral";
    this._requiresPlan = false;
    this._planningPhase = false;
    this._turn = 0;
    this._aborted = false;
    this._lastToolWasExecuted = false;
    this._totalWrites = 0;
    this._plan = null;
    this._planIndex = 0;
    this._lastToolResult = null;
    this._toolCallHistory = [];
    this._completedToolResults.clear();
    this._loopRecoveries = 0;
    this._loopRecoveryExhausted = false;
    this._invalidateInspectionCache();
    this._inspectionCommands.clear();
    this._readOnlyRedirects = 0;
    this._planNarrations = 0;
    this._planMismatches = 0;
    this._postPlanToolRedirects = 0;
    this._invalidToolResponses = 0;
    this._emptyResponses = 0;
    this._transportFailures = 0;
    this._toolEvidence = [];
    this._mutationSnapshots.clear();
    this._patchReviews.clear();
    this._cachedInspectionRedirects = 0;
    this._completionRedirects = 0;
    this._resolvedArtifactDocumentation = false;
    this._researchSources = [];
    this._executionPolicy = null;
    let pendingProse = "";
    let proseContinuations = 0;
    while (this._turn < this._config.maxTurns) {
      if (this._aborted || signal?.aborted) {
        yield { type: "answer", content: "The task was cancelled." };
        return;
      }
      this._turn++;
      this._stepBlocked = false;
      const snapshotPart = this._lifecycle.startStep();
      if (snapshotPart) yield { type: "tool-part", part: snapshotPart };
      yield { type: "thinking", turn: this._turn };

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
      const maxAttempts = /(?:claude|anthropic)/i.test(String(requestModel)) ? 1 : 2;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        let chatErr;
        let receivedAnyToken = false;
        const eventQueue = [];
        let eventResolve = null;
        const queueEvent = event => {
          if (!event) return;
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
          this._markLatency("providerFirstDelta");
          receivedAnyToken = true;
          const text = compatibilityGuard.push(token);
          if (text) queueEvent({ type: "text-delta", text, compatibility: true });
        };
        const onEvent = event => {
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
          signal,
          timeoutMs: this._config.providerTimeout,
          tools: nativeTools,
        })
          .then(result => {
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
          .catch(error => { chatErr = error; });
        const waitForEvent = () => new Promise(resolveEvent => { eventResolve = resolveEvent; });

        while (reply === undefined && chatErr === undefined) {
          const event = eventQueue.length > 0
            ? eventQueue.shift()
            : await Promise.race([waitForEvent(), chatDone.then(() => undefined)]);
          if (event === undefined) continue;
          if (event.type === "reasoning-delta") {
            yield { type: "reasoning", token: event.text };
            continue;
          }
          const token = event.text;
          if (typedProviderStream && !event.compatibility) {
            streamMode = "text";
            streamStarted = true;
            streamVisibleLength += token.length;
            this._markLatency("uiFirstText");
            yield { type: "stream", token };
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
            yield { type: "stream", token: visible };
          }
        }
        while (eventQueue.length > 0) {
          const event = eventQueue.shift();
          if (event.type === "reasoning-delta") {
            yield { type: "reasoning", token: event.text };
            continue;
          }
          const token = event.text;
          if (typedProviderStream && !event.compatibility) {
            streamMode = "text";
            streamStarted = true;
            streamVisibleLength += token.length;
            this._markLatency("uiFirstText");
            yield { type: "stream", token };
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
            yield { type: "stream", token: visible };
          }
        }
        await chatDone.catch(() => {});
        if (!chatErr) break;

        finalError = chatErr;
        if (streamStarted || receivedAnyToken) break;
        if (attempt < maxAttempts - 1) {
          try {
            await this._resetSession({ signal });
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
        if (streamStarted && streamMode === "text") {
          yield { type: "stream-discard" };
        }
        this._debugToolRecovery("transport_failure", finalError?.message || String(finalError));
        for (const lifecyclePart of this._lifecycle.finishStep("error")) {
          yield { type: "tool-part", part: lifecyclePart };
        }
        this._finishLatency();
        yield { type: "error", content: `Provider error: ${redactSecrets(finalError?.message || String(finalError))}` };
        return;
      }
      this._transportFailures = 0;

      if (!reply || !reply.trim() || reply.trim() === "{}" || reply.trim() === "[]") {
        for (const lifecyclePart of this._lifecycle.finishStep("error")) {
          yield { type: "tool-part", part: lifecyclePart };
        }
        this._finishLatency();
        yield { type: "error", content: "Provider returned an empty response." };
        return;
      }
      this._emptyResponses = 0;

      let parsed = nativeToolStream ? this._extractNativeTool(reply) : this._extractTool(reply);
      const commitProseBeforeTool = function* (tool) {
        if (!typedProviderStream) {
          const prose = extractProseBeforeTool(reply, tool);
          const remaining = prose.slice(Math.min(streamVisibleLength, prose.length));
          if (remaining) yield { type: "stream", token: remaining };
        }
        if (streamStarted || !typedProviderStream) yield { type: "stream-commit" };
      };
      if (
        parsed.tools?.length > 1
        && parsed.tools.every(candidate => PARALLEL_READ_ONLY_TOOLS.has(this._normalizeTool(candidate).name))
      ) {
        yield* commitProseBeforeTool(this._normalizeTool(parsed.tools[0]));
        for await (const event of this._runReadOnlyBatch(parsed.tools)) yield event;
        if (this._loopRecoveryExhausted) {
          const answer = this._boundedLoopRecoveryAnswer();
          yield { type: "stream", token: answer };
          yield { type: "stream-end" };
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
          yield { type: "stream", token: answer };
          yield { type: "stream-end" };
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
        yield { type: "stream-discard" };
        this._debugToolRecovery(parsed.kind || "malformed_json", parsed.error);
        const part = this._lifecycle.pending({
          callId: randomUUID(),
          tool: "invalid_tool_call",
          input: { kind: parsed.kind || "malformed_json" },
        });
        this._lifecycle.running(part);
        this._lifecycle.failed(part, parsed.error);
        yield { type: "tool-part", part: { ...part } };
        yield {
          type: "tool-result",
          tool: "invalid_tool_call",
          result: part.state.error,
          callId: part.callId,
          failed: true,
        };
        this._messages.push({ role: "assistant", content: reply });
        this._messages.push({ role: "user", content: `---TOOL ERROR: invalid_tool_call---\n${part.state.error}` });
        for (const lifecyclePart of this._lifecycle.finishStep("tool-error")) {
          yield { type: "tool-part", part: lifecyclePart };
        }
        this._invalidToolResponses = 0;
        continue;
      }
      this._invalidToolResponses = 0;

      if (!tool) {
        let visibleReply = pendingProse ? joinProseContinuation(pendingProse, reply) : reply;
        const displayReply = visibleReply;
        const plan = normalizePlan(extractPlan(visibleReply));
        const interactiveQuestion = extractInteractiveQuestion(visibleReply);
        const missingEvidence = this._missingCompletionEvidence();
        if (missingEvidence) {
          yield { type: "stream-discard" };
          this._completionRedirects++;
          this._messages.push({ role: "assistant", content: reply });
          this._debugToolRecovery("completion_evidence", missingEvidence);
          if (this._taskContract.category === "GIT_OPERATION" && /auth|credential|password|token|permission denied|401|403/i.test(this._activeTask.lastToolResult || "")) {
            const answer = "The commit is stored locally, but push requires GitHub authentication. Provide a token or configure credentials to continue.";
            this._messages.push({ role: "assistant", content: answer });
            yield { type: "answer", content: answer };
            return;
          }
          const steering = this._completionSteering(missingEvidence);
          if (this._completionRedirects >= 3) {
            yield this._steer(steering);
            this._completionRedirects = 0;
            continue;
          }
          yield this._steer(steering);
          continue;
        }

        if (pendingProse) {
          this._markLatency("uiFirstText");
          yield { type: "stream", token: displayReply };
        } else if (streamMode === "text") {
          if (streamTail) {
            this._markLatency("uiFirstText");
            yield { type: "stream", token: streamTail };
          }
        } else {
          const remaining = reply.slice(streamVisibleLength);
          if (remaining) {
            this._markLatency("uiFirstText");
            yield { type: "stream", token: remaining };
          }
        }
        this._messages.push({ role: "assistant", content: visibleReply });
        this._clearPendingAction();
        for (const lifecyclePart of this._lifecycle.finishStep("stop")) {
          yield { type: "tool-part", part: lifecyclePart };
        }
        this._finishLatency();
        yield { type: "stream-end" };
        return;
      }
      yield* commitProseBeforeTool(tool);
      const auxiliaryTool = tool.name === "todowrite";
      tool.id ||= randomUUID();
      const loopRecovery = this._toolLoopRecovery(tool);
      if (loopRecovery) {
        this._lifecycle.finishStep("tool-calls");
        if (loopRecovery.exhausted) {
          const answer = this._boundedLoopRecoveryAnswer();
          yield { type: "stream", token: answer };
          yield { type: "stream-end" };
          return;
        }
        continue;
      }
      this._messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: tool.id,
          type: "function",
          function: { name: tool.name, arguments: JSON.stringify(publicToolArgs(tool.args)) },
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
      result = redactSecrets(result);
      this._rememberToolOutcome(tool, result);
      if (["web", "webfetch", "websearch", "repo"].includes(tool.name)) {
        this._researchSources = [...new Set([...this._researchSources, ...sourceUrls(result)])].slice(0, 20);
      }
      const metadata = toolMetadata(tool, result);
      yield {
        type: "tool-result",
        tool: tool.name,
        result,
        metadata,
        callId: part.callId,
        failed: part.state.status === "error",
      };
      this._toolEvidence.push({
        tool: tool.name,
        args: { ...tool.args },
        result,
        failed: resultFailed(result),
        metadata,
      });
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
        content: result,
      });
      for (const lifecyclePart of this._lifecycle.finishStep(finishReason)) {
        yield { type: "tool-part", part: lifecyclePart };
      }
      yield* this._finishPlanItem(planTracker, part.state.status === "completed" && !resultFailed(result));
    }
    this._finishLatency();
    yield { type: "error", content: `Maximum step count reached (${this._config.maxTurns}).` };
  }
};
