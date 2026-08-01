import { loadConfig } from "../config/index.js";
import { chat, resetSession } from "../lib/llm.js";
import { fallbackIntentContract } from "./intent-resolver.js";
import { randomUUID } from "node:crypto";
import { getAgentProfile } from "./agent-profiles.js";
import { ToolLifecycle } from "./tool-lifecycle.js";
import { InstructionService } from "./instruction.js";
import { PermissionService } from "./permission.js";
import { SkillService } from "./skills.js";
import { workspaceMetadata } from "./agent/helpers/task.js";
import { taskState } from "./agent/helpers/parser.js";
import { StateMethods } from "./agent/state.js";
import { ToolMethods } from "./agent/tools.js";
import { PlanMethods } from "./agent/plan.js";
import { LoopMethods } from "./agent/loop.js";
import { ShellScheduler } from "./shell-scheduler.js";
import { SecretStore } from "./secret-store.js";
import { createToolExecutor } from "./agent/tool-executor-factory.js";
import { ContextUsageTracker } from "./context-usage.js";
import { ContextCache } from "./context-cache.js";
import { resolveEffectiveSettings } from "../config/model-settings.js";
import { configRevision } from "../config/store.js";
import { performance } from "node:perf_hooks";

const COMPACTION_TIMEOUT_MS = 30_000;

export class Agent {
  constructor(registry, opts = {}) {
    this._workspace = opts.workspace || process.cwd();
    this._configOverride = opts.config || null;
    this._config = this._configOverride
      ? { ...loadConfig(this._workspace), ...this._configOverride }
      : loadConfig(this._workspace);
    this._agentProfile = opts.agentProfile || getAgentProfile(
      this._workspace,
      opts.agent || this._config.defaultAgent || "build",
    );
    this._registry = registry.subset?.(this._agentProfile.tools || ["*"]) || registry;
    this._registryReady = typeof registry.load === "function"
      ? registry.load(this._workspace).then(() => {
          this._registry = registry.subset?.(this._agentProfile.tools || ["*"]) || registry;
        })
      : Promise.resolve();
    this._sessionId = String(opts.sessionId || randomUUID());
    this._model = opts.model || this._agentProfile.model || this._config.model;
    this._messages = [];
    this._summary = "";
    this._lastAnalysis = null;
    this._turn = 0;
    this._aborted = false;
    this._activeRun = null;
    this._taskEpoch = 0;
    this._activeScope = null;
    this._plan = null;
    this._planId = null;
    this._currentStepId = null;
    this._planIndex = 0;
    this._planRevision = 0;
    this._planStatus = "active";
    this._lastToolIsRead = false;
    this._depsInstalled = false;
    this._readFiles = new Map();
    this._autoReadDone = new Set();
    this._consecutiveWrites = 0;
    this._consecutiveBash = 0;
    this._lastToolWasExecuted = false;
    this._totalWrites = 0;
    this._lastToolResult = null;
    this._toolCallHistory = [];
    this._completedToolResults = new Map();
    this._loopRecoveries = 0;
    this._loopRecoveryExhausted = false;
    this._questionHandler = opts.questionHandler || null;
    this._permissionHandler = opts.permissionHandler || null;
    this._readOnly = Boolean(opts.readOnly);
    this._permissionService = opts.permissionService || new PermissionService(this._workspace, this._config, {
      agentPermission: this._agentProfile.permission,
      auto: opts.autoApprove,
    });
    this._workspaceMetadata = workspaceMetadata(this._workspace);
    this._lifecycle = new ToolLifecycle({
      sessionId: this._sessionId,
      workspace: this._workspace,
      parts: opts.sessionState?.parts,
      onPart: opts.partHandler,
    });
    this._instructionService = new InstructionService(this._workspace);
    this._skillService = new SkillService(this._workspace);
    this._systemCache = null;
    this._currentRequest = "";
    this._inspectionCommands = new Set();
    this._requestMode = "neutral";
    this._readOnlyRedirects = 0;
    this._planningPhase = false;
    this._requiresPlan = false;
    this._planNarrations = 0;
    this._planMismatches = 0;
    this._postPlanToolRedirects = 0;
    this._requestStartIndex = 0;
    this._invalidToolResponses = 0;
    this._debug = Boolean(opts.debug || process.env.KHAZAI_DEBUG);
    this._latency = null;
    this._emptyResponses = 0;
    this._transportFailures = 0;
    this._toolEvidence = [];
    this._mutationSnapshots = new Map();
    this._patchReviews = new Map();
    this._inspectionCache = new Map();
    this._workspaceListing = null;
    this._cachedInspectionRedirects = 0;
    this._completionRedirects = 0;
    this._acceptedCreationOffer = null;
    this._resolvedArtifactDocumentation = false;
    this._researchSources = [];
    this._pendingGitPush = null;
    this._pendingBatchCalls = [];
    this._executionPolicy = null;
    this._taskContract = fallbackIntentContract("");
    this._activeTask = taskState(this._taskContract, "");
    this._pendingAction = null;
    this._chat = opts.chat || chat;
    this._chatHandlesRetries = opts.chatHandlesRetries ?? !opts.chat;
    this._resetSession = opts.resetSession || resetSession;
    this._recoverableProviderRequest = null;
    this._usageTracker = new ContextUsageTracker(opts.sessionState?.contextUsage);
    this._contextCache = new ContextCache();
    this._toolSchemaCache = new Map();
    this._storedToolResults = new Map();
    this._lastFrameEntry = null;
    this._lastRequestMetrics = null;
    this._providerContextLimit = null;
    this._contextLimitSource = "unknown";
    this._sessionSettingOverrides = opts.sessionSettingOverrides || {};
    this._effectiveSettings = null;
    this._applyEffectiveSettings();
    this._historyRevision = 0;
    this._compactionThresholdCrossed = false;
    this._contextErrorCompactedRunId = null;
    this._compaction = {
      status: "idle",
      runId: null,
      turnId: null,
      taskEpoch: null,
      compactionId: null,
      startedAt: null,
      error: null,
      stableTokens: null,
      reason: null,
    };
    this._progress = {
      lastProgressAt: Date.now(),
      repeatedSearches: 0,
      repeatedReads: 0,
      lastSearchSignature: null,
      lastReadSignature: null,
      compactionAttempt: 0,
      continuationQueued: false,
    };
    this._shellScheduler = new ShellScheduler(this._workspace);
    this._secretStore = new SecretStore();
    const configuredResolver = opts.intentResolver;
    this._intentResolver = typeof configuredResolver === "function"
      ? { resolve: configuredResolver }
      : configuredResolver?.resolve
        ? configuredResolver
        : null;
    if (opts.sessionState) this.restoreSessionState(opts.sessionState);
  }


  abort() {
    this._aborted = true;
    if (this._activeRun) this._activeRun.cancelled = true;
    this._abortController?.abort();
    this._shellScheduler.cancelActive();
    this._lifecycle.beginScope(null);
    this._secretStore.clear();
    this._recoverableProviderRequest = null;
    this._activeScope = null;
    this._clearCompaction();
  }
  _isActiveRun(scope) {
    const run = this._activeRun;
    return Boolean(
      run
      && scope
      && run.runId === scope.runId
      && run.turnId === scope.turnId
      && run.taskEpoch === scope.taskEpoch
      && !run.cancelled
      && !run.finalized
    );
  }
  _authorizeToolCall(call, scope) {
    if (!this._isActiveRun(scope) || this._activeScope?.taskEpoch !== scope.taskEpoch) return false;
    const target = call?.name === "bash"
      ? `shell:${String(call.args?.command || "")}`
      : String(call.args?.path || "");
    if (target && !this._activeScope.allowedTargets.includes(target)) {
      this._activeScope.allowedTargets.push(target);
    }
    return true;
  }
  setModel(model) {
    if (model !== this._model) {
      this.abort();
      this._recoverableProviderRequest = null;
    }
    this._model = model;
    this._systemCache = null;
    this._contextCache.reset();
    this._toolSchemaCache.clear();
  }
  hasRecoverableProviderRequest() {
    return Boolean(
      this._recoverableProviderRequest
      && this._recoverableProviderRequest.model === this._model
    );
  }
  setReasoningEffort(effort) { this._config.reasoningEffort = effort; }
  setQuestionHandler(handler) { this._questionHandler = handler; }
  setPermissionHandler(handler) { this._permissionHandler = handler; }
  mode() { return this._agentProfile?.name === "plan" ? "plan" : "build"; }
  planningContext() {
    return {
      objective: this._currentRequest,
      relevantFiles: [...(this._activeScope?.relevantFiles || [])],
      plan: Array.isArray(this._plan) ? this._plan.map(item => ({ ...item })) : [],
    };
  }
  setAutoApprove(value) { this._permissionService.setAuto(value); }
  redactForDisplay(value) { return this._secretStore.redact(value); }
  redactSerializableForDisplay(value) { return this._secretStore.redactSerializable(value); }
  clearTurnSecrets(scope = {}) { return this._secretStore.clear(scope.runId, scope.turnId); }
  _toolExecutor(scope) { return createToolExecutor(this, scope); }
  isCompacting() {
    return ["preparing", "summarizing", "committing", "recounting"].includes(this._compaction.status);
  }
  isCompactionPending() { return this._compaction.status === "scheduled"; }
  compact() {
    this._compactMessages(true);
    return this.exportSessionState();
  }
  _clearCompaction() {
    this._compaction = {
      status: "idle",
      runId: null,
      turnId: null,
      taskEpoch: null,
      compactionId: null,
      startedAt: null,
      error: null,
      stableTokens: null,
      reason: null,
    };
  }

  _scheduleCompaction(run, reason = "threshold") {
    if (!this._isActiveRun(run) || this._compaction.status !== "idle") return false;
    if (reason === "threshold" && !this._config.automaticCompaction) return false;
    if (reason === "threshold" && !this._contextLimitKnown()) return false;
    const usage = this.contextUsage();
    this._compaction = {
      status: "scheduled",
      runId: run.runId,
      turnId: run.turnId,
      taskEpoch: run.taskEpoch,
      compactionId: randomUUID(),
      startedAt: Date.now(),
      error: null,
      stableTokens: usage.currentContextTokens,
      reason,
    };
    if (reason === "context-error") this._contextErrorCompactedRunId = run.runId;
    return true;
  }

  /**
   * Appends one canonical message and invalidates derived caches. All
   * provider history is appended through this helper; nothing else touches
   * `_messages` in production paths.
   */
  _appendMessage(message) {
    this._messages.push(message);
    this._lastFrameEntry = null;
    return message;
  }

  _storedOutputReference(callId) {
    return `khazai-output:${String(callId || "")}`;
  }

  _conciseToolContent(name, callId, content) {
    const preview = Math.max(0, Number(this._config.toolResultPreviewSize) || 0);
    const text = String(content ?? "");
    if (preview <= 0 || text.length <= preview) {
      return { stored: text, concise: text, truncated: false };
    }
    const reference = this._storedOutputReference(callId);
    const concise = `[Tool result: ${name} · stored output ${reference}]\n${text.slice(0, preview)}\n…(full output available as ${reference})`;
    return { stored: text, concise, truncated: true, reference };
  }

  /**
   * Stores the full tool output outside active provider history and appends
   * a concise structured result (excerpt + stored-output reference) to the
   * canonical history. The full output stays available internally and in
   * the persisted lifecycle parts shown by `/details`.
   */
  _pushToolMessage(name, callId, content) {
    const { stored, concise, truncated, reference } = this._conciseToolContent(name, callId, content);
    if (truncated) {
      this._storedToolResults.set(String(callId || ""), stored);
      if (this._storedToolResults.size > 200) {
        const oldest = this._storedToolResults.keys().next().value;
        if (oldest !== undefined) this._storedToolResults.delete(oldest);
      }
    }
    void reference;
    this._appendMessage({
      role: "tool",
      tool_call_id: callId,
      name,
      content: concise,
    });
    return stored;
  }

  _contextCacheKey() {
    const last = this._messages.at(-1) || null;
    const fingerprint = last
      ? `${this._messages.length}:${this._contextCache.messageMeta(last).hash}`
      : `${this._messages.length}:`;
    return [
      `h:${this._historyRevision}:${fingerprint}`,
      `m:${this._model}`,
      `t:chars4`,
    ].join("|");
  }

  /**
   * Returns the cached provider frame for the current history revision.
   * The returned entry contains `messages` (canonical, unresolved) plus
   * cached token counts, payload size, and validation stats.
   */
  _frame() {
    const effective = this._applyEffectiveSettings();
    const sys = this._buildSystem();
    const activeObjective = [
      "ACTIVE TASK FOR THIS TURN:",
      String(this._activeScope?.objective || this._currentRequest || ""),
      "Treat every earlier task as completed historical context unless this user message explicitly requests continuation.",
    ].join("\n");
    const limit = effective.contextLimit || 0;
    const key = this._contextCacheKey();
    const entry = this._contextCache.buildFrame(key, {
      messages: this._messages,
      requestStartIndex: limit > 0 ? this._requestStartIndex : 0,
      limit,
      sys,
      activeObjective,
      summary: this._summary,
    });
    this._lastFrameEntry = entry;
    this._lastFrameKey = key;
    if (this._debug) {
      const { frameBuilds, frameHits } = this._contextCache.stats;
      console.error(`[khazai debug] context cache builds=${frameBuilds} hits=${frameHits} revision=${key.split("|")[0]}`);
    }
    return entry;
  }

  _markLatencyDuration(name, startMs) {
    if (!this._latency) return;
    this._latency[name] = Math.max(0, performance.now() - startMs);
  }

  latencyReport() {
    const usage = this.contextUsage();
    const metrics = this._lastRequestMetrics || {};
    const number = value => Math.max(0, Number(value) || 0);
    const localPreparationMs = Math.round(
      number(metrics.historyPreparationMs)
      + number(metrics.messageValidationMs)
      + number(metrics.tokenCountingMs)
      + number(metrics.compactionCheckMs)
      + number(metrics.toolSchemaBuildMs)
      + number(metrics.serializationMs),
    );
    return {
      contextTokens: usage.currentContextTokens,
      contextLimit: usage.contextLimit,
      messageCount: metrics.messageCount || 0,
      payloadBytes: metrics.serializedPayloadBytes || 0,
      historyPreparationMs: metrics.historyPreparationMs || 0,
      messageValidationMs: metrics.messageValidationMs || 0,
      tokenCountingMs: metrics.tokenCountingMs || 0,
      compactionCheckMs: metrics.compactionCheckMs || 0,
      compactionMs: metrics.compactionMs || 0,
      toolSchemaBuildMs: metrics.toolSchemaBuildMs || 0,
      serializationMs: metrics.serializationMs || 0,
      requestUploadMs: metrics.requestUploadMs || 0,
      providerTimeToFirstByteMs: metrics.providerTimeToFirstByteMs || 0,
      providerTimeToFirstTokenMs: metrics.providerTimeToFirstTokenMs || 0,
      totalResponseMs: metrics.totalResponseMs || 0,
      localPreparationMs,
      providerPrefillMs: (metrics.providerTimeToFirstTokenMs || 0) + (metrics.requestUploadMs || 0),
      compactionLabel: metrics.compactionLabel || "Not required",
    };
  }

  async replaceRegistry(registry) {
    if (typeof registry.load === "function") await registry.load(this._workspace);
    this._registry = registry.subset?.(this._agentProfile.tools || ["*"]) || registry;
    this._registryReady = Promise.resolve();
    this._toolSchemaCache.clear();
  }
  _applyEffectiveSettings() {
    const settingsKey = [
      this._model,
      this._providerContextLimit,
      configRevision(),
    ].join(":");
    if (this._effectiveSettingsKey === settingsKey && this._effectiveSettings) {
      if (this._config.compactThreshold === undefined) {
        Object.assign(this._config, this._effectiveSettings, {
          compactThreshold: this._effectiveSettings.compactionThreshold,
          emergencyCompactThreshold: this._effectiveSettings.emergencyCompactionThreshold,
        });
      }
      return this._effectiveSettings;
    }
    const effective = resolveEffectiveSettings(this._model, {
      config: this._config,
      sessionOverrides: this._sessionSettingOverrides,
      providerMetadata: { contextLimit: this._providerContextLimit },
    });
    this._effectiveSettingsKey = settingsKey;
    this._effectiveSettings = effective;
    Object.assign(this._config, effective, {
      compactThreshold: effective.compactionThreshold,
      emergencyCompactThreshold: effective.emergencyCompactionThreshold,
    });
    return effective;
  }
  refreshEffectiveSettings() {
    const loaded = loadConfig(this._workspace);
    const current = this._configOverride ? { ...loaded, ...this._configOverride } : loaded;
    this._config = current;
    return {
      settings: this._applyEffectiveSettings(),
      usage: this.contextUsage(),
    };
  }
  _compactionActiveFor(run) {
    return this._compaction.runId === run?.runId
      && this._compaction.turnId === run?.turnId
      && this._compaction.taskEpoch === run?.taskEpoch;
  }
  _recordProgress() {
    this._progress.lastProgressAt = Date.now();
  }
  _checkNoProgress() {
    const elapsed = Date.now() - this._progress.lastProgressAt;
    if (elapsed > 60_000 && this._compaction.status === "compacting") {
      return true;
    }
    return false;
  }
}

for (const source of [StateMethods, ToolMethods, PlanMethods, LoopMethods]) {
  const descriptors = Object.getOwnPropertyDescriptors(source.prototype);
  delete descriptors.constructor;
  Object.defineProperties(Agent.prototype, descriptors);
}
