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

export class Agent {
  constructor(registry, opts = {}) {
    this._workspace = opts.workspace || process.cwd();
    this._config = loadConfig(this._workspace);
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
    this._resetSession = opts.resetSession || resetSession;
    const configuredResolver = opts.intentResolver;
    this._intentResolver = typeof configuredResolver === "function"
      ? { resolve: configuredResolver }
      : configuredResolver?.resolve
        ? configuredResolver
        : null;
    if (opts.sessionState) this.restoreSessionState(opts.sessionState);
  }


  abort() { this._aborted = true; this._abortController?.abort(); }
  setModel(model) { this._model = model; this._systemCache = null; }
  setReasoningEffort(effort) { this._config.reasoningEffort = effort; }
  setQuestionHandler(handler) { this._questionHandler = handler; }
  setPermissionHandler(handler) { this._permissionHandler = handler; }
  setAutoApprove(value) { this._permissionService.setAuto(value); }
  compact() { this._compactMessages(); return this.exportSessionState(); }
}

for (const source of [StateMethods, ToolMethods, LoopMethods]) {
  const descriptors = Object.getOwnPropertyDescriptors(source.prototype);
  delete descriptors.constructor;
  Object.defineProperties(Agent.prototype, descriptors);
}
