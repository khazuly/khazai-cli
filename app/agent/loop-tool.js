import { resultFailed, sourceUrls, toolMetadata } from "./helpers/task.js";

export async function* executeAgentTool({ tool, run, runId, turnId, auxiliaryTool, scoped, isRunActive, finalizeRun, emergencyThreshold }) {
const planTracker = auxiliaryTool ? null : yield* this._startPlanItem(tool, run);
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
if (!isRunActive()) return "stop";
if (!part) return "continue";
if (tool.name === "todowrite" && part.state.status === "completed") {
  const todos = Array.isArray(part.state.metadata?.todos) ? part.state.metadata.todos : [];
  const plan = this._definePlan(todos, run);
  if (plan) yield scoped({
    type: "plan",
    items: plan.map(item => ({ ...item })),
    planId: this._planId,
    currentStepId: this._currentStepId,
    revision: this._planRevision,
    status: this._planStatus,
  });
}
const protectedResult = this._secretStore.protect(result, runId, turnId);
result = this._secretStore.redact(protectedResult);
this._rememberToolOutcome(tool, protectedResult, part.state.status === "error");
if (["web", "webfetch", "websearch", "repo"].includes(tool.name)) {
  this._researchSources = [...new Set([...this._researchSources, ...sourceUrls(result)])].slice(0, 20);
}
const metadata = toolMetadata(tool, result);
const planDenied = part.metadata?.planDenied || part.state.metadata?.planDenied;
const resultMetadata = planDenied ? { ...metadata, hidden: true, planDenied: true } : metadata;
yield scoped({
  type: "tool-result",
  tool: tool.name,
  result,
  metadata: tool.name === "todowrite"
    ? { ...resultMetadata, planItems: Array.isArray(this._plan) ? this._plan.map(item => ({ ...item })) : [] }
    : resultMetadata,
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
this._pushToolMessage(tool.name, part.callId, protectedResult);
yield scoped({ type: "context-usage", usage: this.contextUsage() });
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
  this._progress.repeatedSearches = 0;
  this._progress.repeatedReads = 0;
}
if (this._progress.repeatedSearches >= 2 || this._progress.repeatedReads >= 2) {
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
if (
  (projectedRatio === null || projectedRatio < this._config.compactThreshold)
  && usage.projectedRequestTokens < (this._compactionTokenLimit() || Infinity)
) {
  this._compactionThresholdCrossed = false;
}
if (
  projectedRatio !== null
  && projectedRatio >= emergencyThreshold
  && !this._compactionThresholdCrossed
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
  (projectedRatio !== null && projectedRatio >= this._config.compactThreshold
    || usage.projectedRequestTokens >= (this._compactionTokenLimit() || Infinity))
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
yield* this._finishPlanItem(
  planTracker,
  tool,
  result,
  part.state.status === "completed" && !resultFailed(result),
  run,
);
  return "continue";
}
