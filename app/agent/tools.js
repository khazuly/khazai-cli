import { randomUUID } from "node:crypto";
import { planBatchCanRunConcurrently, runPlanExplorationBatch } from "./plan-exploration.js";
import { publicToolArgs, toolMetadata } from "./helpers/task.js";

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
          status: this._planStatus,
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
      outputHeadroom: this._reservedOutputHeadroom(),
    });
    snapshot.contextLimitSource = source;
    return snapshot;
  }

  compactIfNeeded() {
    const usage = this.contextUsage();
    if (!usage.contextLimitKnown) return false;
    const usableRatio = usage.usableRatio ?? usage.projectedRequestTokens / usage.contextLimit;
    const emergency = Number(this._config.emergencyCompactThreshold) || 0.92;
    if (usableRatio >= emergency) {
      return this._compactMessages(true);
    }
    if (usableRatio < this._config.compactThreshold) return false;
    return this._compactMessages(false);
  }

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
        usableRatio: limit > 0
          ? (Number(projection.tokens) || 0) / Math.max(1, limit - this._reservedOutputHeadroom())
          : null,
      };
      this._markLatencyDuration("serializationMs", serializationStart);
      this._contextCache.setProjection(projectionKey, result);
      return result;
    } catch {
      this._markLatencyDuration("serializationMs", serializationStart);
      return { tokens: 0, contextLimit: null, ratio: null };
    }
  }

  async _toolSchemas(model, agent) {
    const mode = this.mode();
    const key = `${model}|${agent}|${mode}|${this._registry.revision}`;
    const cached = this._toolSchemaCache.get(key);
    if (cached) return cached;
    const schemaStart = performance.now();
    const available = await this._registry.definitions({ model, agent, mode, directory: this._workspace });
    const definitions = available;
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
