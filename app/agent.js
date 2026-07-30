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
import { LoopMethods } from "./agent/loop.js";
import { ShellScheduler } from "./shell-scheduler.js";
import { SecretStore } from "./secret-store.js";
import { createToolExecutor } from "./agent/tool-executor-factory.js";
import { ContextUsageTracker } from "./context-usage.js";
import { resolveEffectiveSettings } from "../config/model-settings.js";

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
    this._planIndex = 0;
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

  async replaceRegistry(registry) {
    if (typeof registry.load === "function") await registry.load(this._workspace);
    this._registry = registry.subset?.(this._agentProfile.tools || ["*"]) || registry;
    this._registryReady = Promise.resolve();
  }
  _applyEffectiveSettings() {
    const effective = resolveEffectiveSettings(this._model, {
      config: this._config,
      sessionOverrides: this._sessionSettingOverrides,
      providerMetadata: { contextLimit: this._providerContextLimit },
    });
    this._effectiveSettings = effective;
    Object.assign(this._config, effective, {
      compactThreshold: effective.compactionThreshold,
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

for (const source of [StateMethods, ToolMethods, LoopMethods]) {
  const descriptors = Object.getOwnPropertyDescriptors(source.prototype);
  delete descriptors.constructor;
  Object.defineProperties(Agent.prototype, descriptors);
}
