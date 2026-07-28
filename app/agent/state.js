import { countTokens } from "../../lib/tokens.js";
import { resolveModelDescriptor } from "../../lib/llm.js";
import { redactSecrets } from "../../lib/secrets.js";
import { sanitizeAssistantIdentity } from "../../lib/assistant-text.js";
import { getProviderPrompt } from "../prompts.js";
import { ExecutionPolicy } from "../execution-policy.js";
import { ToolExecutor } from "../tool-executor.js";
import { resolve } from "node:path";
import { isObject, workspaceMetadata, PARALLEL_READ_ONLY_TOOLS, INSPECTION_TOOLS, IDEMPOTENT_MUTATION_TOOLS, MAX_LOOP_RECOVERIES, sourceUrls, deterministicIdentityAnswer, extractPlan, normalizePlan, requiresPlan, fallbackPlan, extractInteractiveQuestion, toolSignature, publicToolArgs, repeatedToolCycle, cachedToolAnswer, requestMode, declaredSymbols, preservesImplementationStructure, prospectiveFileContent, shouldDeferToolCandidateProse, wantsFileCount, simpleFileListRequest, fileCountFromToolResult, resultFailed, isSteeringOutcome, legacyGuardOutcome, guardErrorOutcome, patchReview, toolMetadata, requestedSampleExtensions, needsFileMutation, needsDeletionMutation, clearWorkspaceRequest, isDeletionCommand, needsExecutionValidation, isValidationCommand, expectedPlanTools, mutationSatisfiesPlanItem, toolMatchesPlanItem, isInspectionCommand, mutatesWorkspace, streamDisposition } from "./helpers/task.js";
import { isProviderParseFailure, isShortContinuation, isNegativeContinuation, pendingActionState, offeredModificationContract, offersFollowUpAction, taskState, extractJsonCandidates, decodeXmlEntities, coerceTaggedArgument, extractTaggedToolCall, LEGACY_PROTOCOL_HOLDBACK, MAX_PROSE_CONTINUATIONS, jsonCompletion, validateToolArguments, delimiterCount, proseLooksIncomplete, stripMarkdown, joinProseContinuation } from "./helpers/parser.js";

export class StateMethods {
  _markLatency(name) {
    if (!this._latency || this._latency[name] !== undefined) return;
    this._latency[name] = performance.now();
  }

  _finishLatency() {
    if (!this._latency) return;
    this._markLatency("completed");
    if (this._debug) {
      const start = this._latency.inputReceived;
      const metric = value => value === undefined ? null : Math.round((value - start) * 10) / 10;
      console.error(`[khazai debug] latency ${JSON.stringify({
        dispatchMs: metric(this._latency.requestDispatched),
        providerFirstDeltaMs: metric(this._latency.providerFirstDelta),
        uiFirstTextMs: metric(this._latency.uiFirstText),
        completedMs: metric(this._latency.completed),
      })}`);
    }
  }

  exportSessionState() {
    const state = {
      version: 4,
      sessionId: this._sessionId,
      messages: this._messages.slice(-200),
      summary: this._summary,
      model: this._model,
      agent: this._agentProfile?.name || "build",
      parts: this._lifecycle.parts.slice(-200),
      permissionApprovals: this._permissionService.approvalHistory(),
      recoverableProviderRequest: this._recoverableProviderRequest,
    };
    return this._secretStore.redactSerializable(state);
  }

  restoreSessionState(state) {
    if (!isObject(state)) return false;
    if (Array.isArray(state.messages)) {
      this._messages = state.messages
        .filter(message => !String(message?.content || "").startsWith("[INTERNAL STEERING]"))
        .slice(-200);
    }
    this._summary = typeof state.summary === "string" ? state.summary : "";
    if (state.model) this._model = String(state.model);
    if (state.sessionId) {
      this._sessionId = String(state.sessionId);
      this._lifecycle.sessionId = this._sessionId;
    }
    if (Array.isArray(state.parts)) this._lifecycle.parts = state.parts.slice(-200);
    this._permissionService.restoreApprovals(state.permissionApprovals);
    this._recoverableProviderRequest = isObject(state.recoverableProviderRequest)
      ? state.recoverableProviderRequest
      : null;
    this._pendingAction = null;
    this._pendingGitPush = null;
    this._currentRequest = this._recoverableProviderRequest?.currentRequest || "";
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

  _rememberToolOutcome(tool, result) {
    const signature = toolSignature(tool, this._workspace);
    const failed = resultFailed(result);
    this._toolCallHistory.push({ signature, failed });
    if (this._toolCallHistory.length > 24) this._toolCallHistory.shift();
    if (failed) return;
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
    const repeatedFailures = this._toolCallHistory
      .filter(entry => entry.signature === signature && entry.failed)
      .length;
    if (repeatedFailures >= 2) return { exhausted: true };
    return null;
  }

  _filterRepeatedBatchTools(tools) {
    const executable = [];
    for (const tool of tools) {
      const recovery = this._toolLoopRecovery(tool);
      if (!recovery) {
        executable.push(tool);
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
    this._messages.push({ role: "assistant", content: answer });
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

  _buildSystem() {
    const revision = this._instructionService.revision();
    const hasSkillTool = Boolean(this._registry.get("skill"));
    const skillRevision = hasSkillTool ? this._skillService.revision() : "";
    let descriptor;
    try {
      descriptor = resolveModelDescriptor(this._model, this._config);
    } catch {
      descriptor = { exactID: this._model };
    }
    const date = new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
    const cacheKey = JSON.stringify({
      model: this._model,
      exactModel: descriptor.exactID,
      agent: this._agentProfile?.name,
      profileInstructions: this._agentProfile?.instructions || "",
      analysis: this._lastAnalysis || "",
      revision,
      skillRevision,
      date,
    });
    if (this._systemCache?.key === cacheKey) return this._systemCache.value;
    this._instructionService.clearCache();
    const instructionBlock = this._instructionService.getSystemPromptBlock();
    const skills = hasSkillTool
      ? this._skillService.list().filter(skill => (
        this._permissionService.evaluate("skill", { name: skill.name }).decision !== "deny"
      ))
      : [];

    const envInfo = [
      `You are powered by the model ${descriptor.exactID}.`,
      `Here is some useful information about the environment you are running in:`,
      `<env>`,
      `  Working directory: ${this._workspaceMetadata.workingDirectory}`,
      `  Worktree: ${this._workspaceMetadata.worktree}`,
      `  Is directory a git repo: ${this._workspaceMetadata.isGitRepo ? "yes" : "no"}`,
      `  Platform: ${process.platform}`,
      `  Today's date: ${date}`,
      `</env>`,
      "",
    ].join("\n");

    const parts = [getProviderPrompt(descriptor.exactID), envInfo];
    if (instructionBlock) parts.push(instructionBlock, "");
    if (this._agentProfile?.instructions) {
      parts.push("ACTIVE AGENT PROFILE:", this._agentProfile.instructions, "");
    }
    if (skills.length) {
      parts.push(
        "AVAILABLE SKILLS:",
        "Use the skill tool to load a skill's full instructions when its description matches the task.",
        ...skills.map(skill => `- ${skill.name}: ${skill.description}`),
        "",
      );
    }

    if (this._lastAnalysis) {
      parts.push("LATEST ANALYSIS:", this._lastAnalysis, "");
    }
    const value = parts.join("\n");
    this._systemCache = { key: cacheKey, value };
    return value;
  }

  _parseToolJson(parsed) {
    if (typeof parsed === "string") {
      try { return this._parseToolJson(JSON.parse(parsed)); } catch { return null; }
    }
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        const tool = this._parseToolJson(entry);
        if (tool) return tool;
      }
      return null;
    }
    if (typeof parsed?.tool === "string" && parsed.tool.trim() && isObject(parsed.args)) {
      const tool = { name: parsed.tool, args: parsed.args };
      const id = parsed.id || parsed.tool_call_id;
      if (id) tool.id = id;
      return tool;
    }
    if (typeof parsed?.tool === "string" && parsed.tool.trim() && isObject(parsed.arguments)) {
      return { name: parsed.tool, args: parsed.arguments };
    }
    if (typeof parsed?.tool === "string" && parsed.tool.trim()) {
      const registered = this._registry.get(parsed.tool);
      const properties = registered?.parameters?.properties || {};
      const args = Object.fromEntries(
        Object.keys(properties)
          .filter(key => Object.hasOwn(parsed, key))
          .map(key => [key, parsed[key]]),
      );
      if (registered && Object.keys(args).length > 0) {
        return { name: parsed.tool, args };
      }
    }
    if (typeof parsed?.name === "string" && parsed.name.trim()) {
      let args = parsed.arguments ?? parsed.input ?? parsed.parameters;
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { args = null; }
      }
      if (isObject(args)) return { name: parsed.name, args };
    }
    if (isObject(parsed?.function)) {
      return this._parseToolJson(parsed.function);
    }
    for (const container of [parsed?.tool_calls, parsed?.function_calls, parsed?.content]) {
      if (Array.isArray(container)) {
        const tool = this._parseToolJson(container);
        if (tool) return tool;
      }
    }
    const keys = Object.keys(parsed || {});
    if (keys.length === 1 && isObject(parsed[keys[0]]) && this._registry.get(keys[0])) {
      return { name: keys[0], args: parsed[keys[0]] };
    }
    return null;
  }

  _extractNativeTool(text) {
    try {
      const parsed = JSON.parse(String(text || "").trim());
      if (Array.isArray(parsed)) {
        const tools = parsed.slice(0, 8).map(entry => this._parseToolJson(entry)).filter(Boolean);
        return tools.length ? { tool: tools[0], tools, error: null, kind: null } : { tool: null, error: null, kind: null };
      }
      const tool = this._parseToolJson(parsed);
      return { tool, error: null, kind: null };
    } catch {
      return { tool: null, error: "Native tool call payload was malformed.", kind: "malformed_json", truncated: false };
    }
  }

  _extractTool(text) {
    const reply = text.trim();
    const toolNames = this._registry.list().map(t => t.name).join("|");

    if (isProviderParseFailure(reply)) {
      return { tool: null, error: "provider response could not be parsed", truncated: false, kind: "provider_parse_failure" };
    }

    try {
      const parsed = JSON.parse(reply);
      if (Array.isArray(parsed)) {
        const tools = parsed.slice(0, 8).map(entry => this._parseToolJson(entry)).filter(Boolean);
        if (tools.length) return { tool: tools[0], tools, error: null, kind: null };
      }
      const tool = this._parseToolJson(parsed);
      if (tool) return { tool, error: null, kind: null };
    } catch {}

    for (const candidate of extractJsonCandidates(reply)) {
      try {
        const parsed = JSON.parse(candidate);
        const tool = this._parseToolJson(parsed);
        if (tool) return { tool, error: null, kind: null };
      } catch { continue; }
    }

    const taggedTool = extractTaggedToolCall(reply, this._registry);
    if (taggedTool) return { tool: taggedTool, error: null, kind: null };

    const toolLike = /<\s*\/?\s*(?:function|tool)_calls?/i.test(reply)
      || /<\s*(?:invoke|tool_call)\b/i.test(reply)
      || /["']tool["']\s*:/i.test(reply)
      || /["'](?:tool_calls|function_calls|tool_use)["']\s*:/i.test(reply)
      || new RegExp(`["'](?:${toolNames})["']\\s*:`).test(reply);
    if (toolLike) {
      const completion = jsonCompletion(reply);
      const truncated = completion === "truncated";
      return {
        tool: null,
        error: truncated
          ? "The tool call was truncated before its JSON payload completed."
          : "Found tool-like text but could not parse a valid JSON tool call.",
        truncated,
        kind: truncated ? "truncated_json" : "malformed_json",
      };
    }

    return { tool: null, error: null, kind: null };
  }

  _debugToolRecovery(kind, detail) {
    if (this._debug) console.error(`[khazai debug] tool recovery (${kind}): ${this._secretStore.redact(detail)}`);
  }

  _steer({ detectedIntent, proposedAction, recommendedAction, guidance }) {
    const event = {
      type: "steering",
      needsSteering: true,
      detectedIntent: detectedIntent || this._taskContract?.category || "UNKNOWN",
      proposedAction: proposedAction || "tool action",
      recommendedAction: recommendedAction || "continue safely",
      guidance: redactSecrets(guidance || "Continue from the current task state with a safe next action."),
    };
    if (this._debug) console.error(`[khazai debug] steering ${JSON.stringify(event)}`);
    this._messages.push({
      role: "user",
      content: `[INTERNAL STEERING]\nDetected intent: ${event.detectedIntent}\nProposed action: ${event.proposedAction}\nRecommended action: ${event.recommendedAction}\nGuidance: ${event.guidance}`,
    });
    return event;
  }

  _toolRecoveryInstruction(kind, attempt, detail = "") {
    const common = "Continue the current task from the existing plan, tool results, and unfinished action; do not restart. Return exactly one complete JSON tool call, with no markdown or surrounding text.";
    const compact = "Use one operation only. Do not combine actions. Keep arguments small; for a large edit, first inspect or make one smaller edit per step.";
    const guidance = {
      truncated_json: `Your previous tool JSON was cut off. ${compact} If content is large, split it into several valid write/edit operations. Ensure every quote, brace, and array is closed.`,
      malformed_json: `Your previous tool JSON was malformed. ${compact} Follow the tool schema exactly and emit valid JSON only.`,
      unknown_tool: "The requested tool does not exist. Choose one tool from the supplied tool schema and preserve the current unfinished action.",
      missing_required_argument: `The call omitted ${detail || "a required argument"}. Include every required argument from the selected tool schema. ${compact}`,
      schema_validation: `The call does not match the selected tool schema (${detail || "invalid arguments"}). Correct argument names and types. ${compact}`,
      provider_parse_failure: `The previous provider response was not usable. ${compact} Reissue the next expected action using the current task state and tool schema.`,
    };
    const escalation = attempt > 1
      ? " The previous correction did not produce an executable call. Change strategy now: inspect the exact target first when context is missing; for an existing file, use one edit patch with exact oldString/newString; for a new file, use one small write; for shell work, run one command only."
      : "";
    return `Internal tool-call recovery: ${guidance[kind] || guidance.malformed_json}${escalation}\n${common}`;
  }

  _normalizeTool(tool) {
    return tool;
  }

  _prepareToolArgs(name, input) {
    const args = { ...(input || {}) };
    if (name === "bash") {
      args.workdir = args.workdir
        ? resolve(this._workspace, String(args.workdir))
        : this._workspace;
    }
    if (["read", "write", "edit", "analyze", "glob", "grep"].includes(name)
      && args.path && !String(args.path).startsWith("/")) {
      args.path = resolve(this._workspace, String(args.path));
    }
    if (["read", "write", "edit", "apply_patch", "analyze", "glob", "grep", "task"].includes(name)) {
      args._agentWorkspace = this._workspace;
    }
    return args;
  }

  _toolExecutor() {
    return new ToolExecutor({
      registry: this._registry,
      lifecycle: this._lifecycle,
      permissionService: this._permissionService,
      permissionHandler: request => this._permissionHandler?.(request),
      questionHandler: question => this._questionHandler?.(question),
      workspace: this._workspace,
      worktree: this._workspaceMetadata.worktree,
      sessionId: this._sessionId,
      normalizeCall: call => this._normalizeTool(call),
      prepareArgs: (name, args) => this._prepareToolArgs(name, args),
      resultFailed,
      timeoutMs: this._config.toolTimeout,
      signal: this._abortController?.signal,
      taskContext: this._executionPolicy,
      runId: this._activeRun?.runId,
      turnId: this._activeRun?.turnId,
      shellScheduler: this._shellScheduler,
      protectOutput: value => this._protectForContext(value),
      protectData: value => this._protectDataForContext(value),
      redactOutput: value => this.redactForDisplay(value),
    });
  }


};
