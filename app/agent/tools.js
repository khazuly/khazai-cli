import { execAsync } from "../../lib/exec-async.js";
import { countTokens } from "../../lib/tokens.js";
import { existsSync, readFileSync, statSync, writeFileSync, mkdtempSync, chmodSync, rmSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { redactSecrets } from "../../lib/secrets.js";
import { ToolExecutor } from "../tool-executor.js";
import { normalizeIntentContract } from "../intent-resolver.js";
import { randomUUID } from "node:crypto";
import { isObject, workspaceMetadata, PARALLEL_READ_ONLY_TOOLS, INSPECTION_TOOLS, IDEMPOTENT_MUTATION_TOOLS, MAX_LOOP_RECOVERIES, sourceUrls, deterministicIdentityAnswer, extractPlan, normalizePlan, requiresPlan, fallbackPlan, extractInteractiveQuestion, toolSignature, publicToolArgs, repeatedToolCycle, cachedToolAnswer, requestMode, declaredSymbols, preservesImplementationStructure, prospectiveFileContent, shouldDeferToolCandidateProse, wantsFileCount, simpleFileListRequest, fileCountFromToolResult, resultFailed, isSteeringOutcome, legacyGuardOutcome, guardErrorOutcome, patchReview, toolMetadata, requestedSampleExtensions, needsFileMutation, needsDeletionMutation, clearWorkspaceRequest, isDeletionCommand, needsExecutionValidation, isValidationCommand, expectedPlanTools, mutationSatisfiesPlanItem, toolMatchesPlanItem, isInspectionCommand, mutatesWorkspace, streamDisposition } from "./helpers/task.js";
import { isProviderParseFailure, isShortContinuation, isNegativeContinuation, pendingActionState, offeredModificationContract, offersFollowUpAction, taskState, extractJsonCandidates, decodeXmlEntities, coerceTaggedArgument, extractTaggedToolCall, LEGACY_PROTOCOL_HOLDBACK, MAX_PROSE_CONTINUATIONS, jsonCompletion, validateToolArguments, delimiterCount, proseLooksIncomplete, stripMarkdown, joinProseContinuation } from "./helpers/parser.js";

export class ToolMethods {
  _scopedToolEvent(event) {
    return {
      ...event,
      runId: this._activeRun?.runId,
      turnId: this._activeRun?.turnId,
    };
  }

  _recordShellReuse(tool, decision) {
    const result = redactSecrets(String(decision.result || ""));
    this._messages.push({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: tool.id,
        type: "function",
        function: { name: tool.name, arguments: JSON.stringify(publicToolArgs(tool.args)) },
      }],
    });
    this._messages.push({
      role: "tool",
      tool_call_id: tool.id,
      name: tool.name,
      content: result,
    });
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
    this._messages.push({ role: "assistant", content: answer });
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

  *_startPlanItem() {
    const plan = this._plan;
    const index = this._planIndex;
    if (!plan || index >= plan.length) return null;
    plan[index].status = "running";
    yield { type: "plan-update", index, status: "running" };
    return { plan, index };
  }

  *_finishPlanItem(tracker, succeeded) {
    if (!tracker || this._plan !== tracker.plan) return;
    const { plan, index } = tracker;
    plan[index].status = succeeded ? "done" : "failed";
    yield { type: "plan-update", index, status: plan[index].status };
    if (succeeded) this._planIndex = index + 1;
  }

  async *_runReadOnlyBatch(tools) {
    const candidates = tools.slice(0, 8).map(tool => this._normalizeTool(tool));
    const normalized = this._filterRepeatedBatchTools(candidates);
    if (this._loopRecoveryExhausted || normalized.length === 0) {
      this._lifecycle.finishStep("tool-calls");
      return true;
    }
    if (!normalized.every(tool => PARALLEL_READ_ONLY_TOOLS.has(tool.name))) return false;
    const planTracker = yield* this._startPlanItem();
    for (const call of normalized) {
      yield this._scopedToolEvent({ type: "tool-call", tool: call.name, args: { ...call.args }, callId: call.id });
    }
    const settled = [];
    const concurrency = Math.min(8, Math.max(1, Number(this._config.toolConcurrency) || 4));
    for await (const event of this._toolExecutor().executeBatch(
      normalized,
      { agent: this._agentProfile?.name },
      concurrency,
    )) {
      if (event.type === "execution-result") {
        settled.push({ tool: event.call, part: event.part, result: event.result, failed: event.failed });
      } else {
        yield event;
      }
    }
    this._messages.push({
      role: "assistant",
      content: null,
      tool_calls: settled.map(entry => ({
        id: entry.tool.id,
        type: "function",
        function: {
          name: entry.tool.name,
          arguments: JSON.stringify(publicToolArgs(entry.tool.args)),
        },
      })),
    });
    for (const entry of settled) {
      const result = redactSecrets(String(entry.result));
      const metadata = toolMetadata(entry.tool, result);
      const failed = entry.failed || resultFailed(result);
      this._rememberToolOutcome(entry.tool, result);
      this._toolEvidence.push({ tool: entry.tool.name, args: { ...entry.tool.args }, result, failed, metadata });
      this._messages.push({
        role: "tool",
        tool_call_id: entry.tool.id,
        name: entry.tool.name,
        content: result,
      });
      if (["websearch", "webfetch", "repo"].includes(entry.tool.name)) {
        this._researchSources = [...new Set([...this._researchSources, ...sourceUrls(result)])].slice(0, 20);
      }
      this._lastToolResult = result;
      this._activeTask.lastToolResult = result.slice(0, 1500);
    }
    for (const part of this._lifecycle.finishStep(this._stepBlocked ? "denied" : "tool-calls")) {
      yield this._scopedToolEvent({ type: "tool-part", part });
    }
    this._lastToolWasExecuted = settled.length > 0;
    yield* this._finishPlanItem(planTracker, settled.some(entry => !resultFailed(entry.result)));
    return true;
  }

  async *_runSequentialBatch(tools) {
    const candidates = tools.slice(0, 8).map(tool => this._normalizeTool(tool));
    const calls = this._schedulableShellCalls(this._filterRepeatedBatchTools(candidates));
    if (this._loopRecoveryExhausted || calls.length === 0) {
      this._lifecycle.finishStep("tool-calls");
      return true;
    }
    this._messages.push({
      role: "assistant",
      content: null,
      tool_calls: calls.map(call => ({
        id: call.id || (call.id = randomUUID()),
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(publicToolArgs(call.args)),
        },
      })),
    });
    let failed = false;
    for (const call of calls) {
      yield this._scopedToolEvent({ type: "tool-call", tool: call.name, args: { ...call.args }, callId: call.id });
      const planTracker = call.name === "todowrite" ? null : yield* this._startPlanItem();
      let callFailed = false;
      let completedPart = null;
      for await (const event of this._toolExecutor().execute(call, { agent: this._agentProfile?.name })) {
        if (event.type !== "execution-result") {
          yield event;
          continue;
        }
        const result = redactSecrets(String(event.result));
        completedPart = event.part;
        failed ||= event.failed;
        callFailed ||= event.failed;
        const metadata = toolMetadata(event.call, result);
        this._rememberToolOutcome(event.call, result);
        this._toolEvidence.push({
          tool: event.call.name,
          args: { ...event.call.args },
          result,
          failed: event.failed,
          metadata,
        });
        this._messages.push({
          role: "tool",
          tool_call_id: event.call.id,
          name: event.call.name,
          content: result,
        });
        this._lastToolResult = result;
        this._activeTask.lastToolResult = result.slice(0, 1500);
      }
      if (call.name === "todowrite" && completedPart?.state.status === "completed") {
        const todos = Array.isArray(completedPart.state.metadata?.todos) ? completedPart.state.metadata.todos : [];
        this._plan = todos.map(todo => ({
          description: todo.content,
          status: todo.status === "completed" ? "done" : todo.status === "in_progress" ? "running" : "pending",
        }));
        const nextPlanIndex = this._plan.findIndex(item => item.status !== "done");
        this._planIndex = nextPlanIndex < 0 ? this._plan.length : nextPlanIndex;
        yield { type: "plan", items: this._plan.map(item => ({ ...item })) };
      }
      yield* this._finishPlanItem(planTracker, !callFailed);
    }
    for (const part of this._lifecycle.finishStep(failed ? "tool-error" : "tool-calls")) {
      yield this._scopedToolEvent({ type: "tool-part", part });
    }
    this._lastToolWasExecuted = calls.length > 0;
    return true;
  }

  _messageTokenUsage() {
    return this._messages.reduce((total, message) => (
      total
      + countTokens(String(message.content || ""))
      + countTokens(JSON.stringify(message.tool_calls || []))
    ), 0);
  }

  contextUsage() {
    const tokens = this._messageTokenUsage();
    const budget = Math.max(1, Number(this._config.tokenBudget) || 1);
    return { tokens, budget, percent: Math.min(100, Math.floor((tokens / budget) * 100)) };
  }

  compactIfNeeded() {
    return this._compactMessages(false);
  }

  _compactMessages(force = false) {
    const usage = this._messageTokenUsage();
    if (!force && usage < this._config.tokenBudget * this._config.compactThreshold) return false;
    if (this._messages.length < 2) return false;

    const target = this._config.tokenBudget * (force ? 0.2 : 0.45);
    let keptTokens = 0;
    let keepFrom = this._messages.length;
    for (let index = this._messages.length - 1; index >= 0; index--) {
      const message = this._messages[index];
      const size = countTokens(String(message.content || ""))
        + countTokens(JSON.stringify(message.tool_calls || []));
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
    if (transcript) {
      this._summary = [this._summary, transcript].filter(Boolean).join("\n").slice(-8000);
    }
    this._messages = this._messages.slice(keepFrom);
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
    const command = String(input || "").slice(1).trim();
    if (!command) {
      const answer = "Enter a command after !.";
      this._messages.push({ role: "user", content: input });
      this._messages.push({ role: "assistant", content: answer });
      yield { type: "stream", token: answer };
      yield { type: "stream-end" };
      return;
    }

    this._taskContract = normalizeIntentContract({
      intent: "change",
      category: "SHELL_OPERATION",
      operation: "shell",
      requiredEvidence: ["shell"],
      modifiesFiles: false,
    }, input);
    this._activeTask = taskState(this._taskContract, input);
    this._currentRequest = input;
    this._messages.push({ role: "user", content: input });
    this._requestStartIndex = this._messages.length - 1;
    this._toolEvidence = [];
    this._toolCallHistory = [];
    this._completedToolResults.clear();
    this._invalidateInspectionCache();

    const snapshot = this._lifecycle.startStep();
    if (snapshot) yield this._scopedToolEvent({ type: "tool-part", part: snapshot });
    const call = {
      id: randomUUID(),
      name: "bash",
      args: { command, workdir: this._workspace },
    };
    this._shellScheduler.reserve(call);
    yield this._scopedToolEvent({ type: "tool-call", tool: call.name, args: { ...call.args }, callId: call.id });
    this._messages.push({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(publicToolArgs(call.args)),
        },
      }],
    });
    let result = "";
    let failed = false;
    let finishReason = "tool-calls";
    for await (const event of this._toolExecutor().execute(call, { agent: this._agentProfile?.name })) {
      if (event.type === "execution-result") {
        result = redactSecrets(String(event.result || ""));
        failed = Boolean(event.failed);
        finishReason = event.finishReason;
      } else {
        yield event;
      }
    }
    this._messages.push({
      role: "tool",
      tool_call_id: call.id,
      name: call.name,
      content: result.slice(0, 6000),
    });
    this._toolEvidence.push({ tool: "bash", args: call.args, result, failed, metadata: toolMetadata(call, result) });
    this._lastToolResult = result;
    this._activeTask.lastToolResult = result.slice(0, 1500);
    for (const lifecyclePart of this._lifecycle.finishStep(finishReason)) {
      yield this._scopedToolEvent({ type: "tool-part", part: lifecyclePart });
    }
    const exitCode = /^Exit:\s*(-?\d+)/im.exec(result)?.[1];
    const answer = failed
      ? `Command finished with exit code ${exitCode ?? "unknown"}.`
      : `Command finished with exit code ${exitCode ?? "0"}.`;
    this._messages.push({ role: "assistant", content: answer });
    this._finishLatency();
    yield { type: "stream", token: answer };
    yield { type: "stream-end" };
  }

  _buildContext() {
    const sys = this._buildSystem();
    const summary = this._summary
      ? [{ role: "assistant", content: `Earlier conversation summary:\n${this._summary}` }]
      : [];
    let used = countTokens(sys) + countTokens(summary[0]?.content || "");
    const selected = [];
    for (let index = this._messages.length - 1; index >= 0; index--) {
      const message = this._messages[index];
      if (String(message.content || "").startsWith("[INTERNAL STEERING]")) continue;
      const size = countTokens(String(message.content || ""))
        + countTokens(JSON.stringify(message.tool_calls || []));
      if (selected.length > 0 && used + size > this._config.tokenBudget) break;
      selected.unshift(message);
      used += size;
    }
    while (selected.length > 0 && selected[0]?.role === "tool") {
      const idx = this._messages.indexOf(selected[0]);
      if (idx > 0) {
        selected.unshift(this._messages[idx - 1]);
      } else {
        selected.shift();
      }
    }
    return [{ role: "system", content: sys }, ...summary, ...selected];
  }


};
