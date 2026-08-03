import { performance } from "node:perf_hooks";

export async function* runScheduledCompaction(run, { isRunActive, scoped, finalizeRun }) {
if (this._compaction.status === "scheduled" && this._compactionActiveFor(run)) {
  const compactionId = this._compaction.compactionId;
  const compactionStart = performance.now();
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
  const preparationStartedAt = performance.now();
  const compacted = failed ? null : this._buildCompactedMessages(true);
  this._markLatencyDuration("compactionPreparationMs", preparationStartedAt);
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
      this._compactedRevisions.add(revisionAtSchedule);
      this._compactedRevisions.add(this._historyRevision);
      this._compactedCheckpoint = {
        contextRevision: this._historyRevision,
        sourceRevision: revisionAtSchedule,
        messages: this._messages,
        summary: this._summary,
        requestStartIndex: this._requestStartIndex,
      };
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
  this._markLatencyDuration("compactionMs", compactionStart);
  this._latency.compactionLabel = "Compacted";
  this._recordProgress();
  yield scoped({
    type: "compaction-state",
    status: "completed",
    compactionId,
    usage: this.contextUsage(),
  });
  this._clearCompaction();
}
  return true;
}
