import { performance } from "node:perf_hooks";
import { emitRequestMetrics } from "../performance-timings.js";

const COMPACTION_DEADLINE_MS = 30_000;

export async function* runScheduledCompaction(run, { isRunActive, scoped, finalizeRun }) {
  if (this._compaction.status !== "scheduled" || !this._compactionActiveFor(run)) return true;
  const compactionId = this._compaction.compactionId;
  const sourceRevision = this._historyRevision;
  const started = performance.now();
  const controller = new AbortController();
  const abort = () => controller.abort(run.controller?.signal?.reason);
  run.controller?.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Compaction timed out.")), COMPACTION_DEADLINE_MS);
  const transition = status => {
    if (!isRunActive() || this._compaction.compactionId !== compactionId) return null;
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
  let fallback = false;
  try {
    const preparing = transition("preparing");
    if (!preparing) throw new Error("Compaction run is no longer active.");
    yield preparing;
    const candidate = this._buildCompactedMessages(
      ["emergency", "context-error"].includes(this._compaction.reason),
    );
    if (!candidate) throw new Error("No compactable history is available.");
    const summarizing = transition("summarizing");
    if (!summarizing) throw new Error("Compaction run is no longer active.");
    yield summarizing;
    candidate.summary = await this._summarizeCompaction(candidate, controller.signal);
    candidate.estimatedTokens = Math.ceil(candidate.summary.length / 4)
      + this._messages.slice(candidate.tailStartIndex).reduce(
        (sum, message) => sum + this._contextCache.messageMeta(message).size,
        0,
      );
    const committing = transition("committing");
    if (!committing) throw new Error("Compaction run is no longer active.");
    yield committing;
    if (!isRunActive() || !this._commitCompaction(candidate, sourceRevision)) {
      throw new Error("Conversation changed during compaction.");
    }
    const recounting = transition("recounting");
    if (!recounting) throw new Error("Compaction run is no longer active.");
    yield recounting;
  } catch (error) {
    if (!isRunActive() || run.controller?.signal?.aborted) {
      failed = true;
      if (this._compaction.compactionId === compactionId) {
        this._compaction.status = "failed";
        this._compaction.error = error?.message || String(error);
        yield scoped({ type: "compaction-state", status: "failed", compactionId });
      }
    } else {
      const fallbackCandidate = this._buildCompactedMessages(true);
      if (fallbackCandidate && this._commitCompaction(fallbackCandidate, sourceRevision)) {
        this._compaction.status = "completed";
        this._compaction.stableTokens = null;
        if (this._latency) this._latency.compactionLabel = "Compacted locally";
        fallback = true;
      } else {
        failed = true;
        if (this._compaction.compactionId === compactionId) {
          this._compaction.status = "failed";
          this._compaction.error = error?.message || String(error);
          yield scoped({ type: "compaction-state", status: "failed", compactionId });
        }
      }
    }
  } finally {
    clearTimeout(timer);
    run.controller?.signal?.removeEventListener("abort", abort);
  }
  if (failed || !isRunActive()) {
    this._clearCompaction();
    return false;
  }
  this._compaction.status = "completed";
  this._compaction.stableTokens = null;
  this._markLatencyDuration("compactionMs", started);
  emitRequestMetrics("compaction", {
    compactionMs: this._latency?.compactionMs ?? null,
    compactionBeforeTokens: this._latency?.compactionBeforeTokens ?? null,
    compactionAfterTokens: this._latency?.compactionAfterTokens ?? null,
    sourceRevision,
    resultRevision: this._historyRevision,
  });
  if (this._latency) this._latency.compactionLabel = "Compacted";
  this._recordProgress();
  yield scoped({
    type: "compaction-state",
    status: "completed",
    compactionId,
    fallback,
    usage: this.contextUsage(),
  });
  this._clearCompaction();
  return true;
}
