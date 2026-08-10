import { randomUUID } from "node:crypto";
import { OLD_TOOL_RESULT_MARKER } from "../context-cache.js";

const SUMMARY_PROMPT = `Create a compact continuation handoff for another coding agent.
Preserve exact user intent, active constraints, decisions, file paths, symbols, commands, errors, versions, URLs, completed work and evidence, unresolved problems, and the precise next step.
Separate completed work from pending work. Never claim a tool succeeded without evidence. Do not include secrets.
Return only the handoff summary with these headings: Goal, Constraints, Decisions, Files and Changes, Completed and Evidence, Errors and Findings, Pending Work, Next Step.`;

function tokenSize(agent, messages) {
  return messages.reduce((sum, message) => sum + agent._contextCache.messageMeta(message).size, 0);
}

function cleanContent(value, maximum = 2_000) {
  const text = String(value ?? "");
  return text.length <= maximum ? text : `${text.slice(0, maximum)}\n[truncated]`;
}

export class CompactionMethods {
  _compactionTokenLimit() {
    const effective = this._applyEffectiveSettings();
    const usable = effective.contextLimit
      ? Math.max(1, effective.contextLimit - this._reservedOutputHeadroom())
      : null;
    const soft = Number(this._config.compactionSoftLimit ?? effective.compactionSoftLimit);
    if (Number.isFinite(soft) && soft > 0) return usable ? Math.min(usable, soft) : soft;
    return usable;
  }

  _shouldCompactUsage(usage = this.contextUsage()) {
    if (!this._config.automaticCompaction) return false;
    const limit = this._compactionTokenLimit();
    if (limit && usage.projectedRequestTokens >= limit) return true;
    if (!usage.contextLimitKnown) return false;
    return (usage.usableRatio ?? 0) >= this._config.compactThreshold;
  }

  _recentTailStart(force = false) {
    const effective = this._applyEffectiveSettings();
    const usable = Math.max(1, (effective.contextLimit || this._config.tokenBudget || 24_000) - this._reservedOutputHeadroom());
    const budget = force
      ? Math.max(128, Math.min(8_000, Math.floor(usable * 0.2)))
      : Math.max(128, Math.min(8_000, Math.floor(usable * 0.25)));
    const turnLimit = Math.max(1, Number(this._config.preserveRecentTurns) || 2);
    const starts = [];
    for (let index = this._tailStartIndex; index < this._messages.length; index++) {
      if (this._messages[index]?.role === "user") starts.push(index);
    }
    const candidates = starts.slice(-turnLimit);
    if (!candidates.length) return Math.max(this._tailStartIndex, this._messages.length - 2);
    let keepFrom = candidates.at(-1);
    let used = tokenSize(this, this._messages.slice(keepFrom));
    for (let index = candidates.length - 2; index >= 0; index--) {
      const candidate = candidates[index];
      const size = tokenSize(this, this._messages.slice(candidate, keepFrom));
      if (used + size > budget) break;
      used += size;
      keepFrom = candidate;
    }
    if (used <= budget) return force && keepFrom === this._tailStartIndex
      ? Math.max(this._tailStartIndex + 1, Math.floor(this._messages.length / 2))
      : keepFrom;
    let start = keepFrom;
    while (start < this._messages.length - 1 && tokenSize(this, this._messages.slice(start)) > budget) start++;
    while (start < this._messages.length && this._messages[start]?.role === "tool") start++;
    return Math.min(start, this._messages.length - 1);
  }

  _serializeCompactionHead(keepFrom) {
    const transcript = this._messages.slice(this._tailStartIndex, keepFrom).map(message => {
      if (message.role === "tool") {
        return `[Tool ${message.name || "tool"} ${message.tool_call_id || ""}]: ${cleanContent(message.content)}`;
      }
      const calls = Array.isArray(message.tool_calls)
        ? `\n[Tool calls]: ${cleanContent(JSON.stringify(message.tool_calls))}`
        : "";
      return `[${message.role === "user" ? "User" : "Assistant"}]: ${cleanContent(message.content, 8_000)}${calls}`;
    }).filter(Boolean).join("\n\n");
    const maximum = Math.max(8_000, Math.min(120_000, (this._compactionTokenLimit() || 30_000) * 3));
    if (transcript.length <= maximum) return transcript;
    const prefix = Math.floor(maximum * 0.25);
    return `${transcript.slice(0, prefix)}\n\n[older transcript omitted]\n\n${transcript.slice(-(maximum - prefix))}`;
  }

  _preservePlanBlock() {
    const parts = [];
    if (this._currentRequest) parts.push(`Objective: ${this._currentRequest}`);
    if (Array.isArray(this._plan) && this._plan.length) {
      const step = this._currentStepId ? this._plan.find(item => item.stepId === this._currentStepId) : null;
      parts.push(`Plan: ${this._plan.length} steps; current: ${step?.title || step?.description || this._currentStepId || "next"}`);
    }
    if (this._activeScope?.changedFiles?.length) parts.push(`Modified files: ${this._activeScope.changedFiles.join(", ")}`);
    if (this._activeTask?.pendingProblem) parts.push(`Unresolved: ${String(this._activeTask.pendingProblem).slice(0, 1_000)}`);
    return parts.join("\n");
  }

  _maxSummaryChars() {
    return Math.max(1_024, Math.floor((Number(this._config.maxCompactedSummarySize) || 4_096) * 4));
  }

  _fallbackSummary(keepFrom) {
    const previous = this._summary ? `Previous summary:\n${this._summary}` : "";
    const state = this._preservePlanBlock();
    const transcript = this._messages.slice(this._tailStartIndex, keepFrom)
      .filter(message => ["user", "assistant"].includes(message.role) && message.content)
      .map(message => `[${message.role === "user" ? "User" : "Assistant"}]: ${cleanContent(message.content, 180)}`)
      .join("\n");
    const marker = this._messages.slice(this._tailStartIndex, keepFrom).some(message => message.role === "tool")
      ? OLD_TOOL_RESULT_MARKER
      : "";
    const tokenLimit = this._compactionTokenLimit() || this._config.tokenBudget || 24_000;
    const maximum = Math.min(this._maxSummaryChars(), 1_024, Math.max(512, Math.floor(tokenLimit * 0.1) * 4));
    const rawHead = [previous, state].filter(Boolean).join("\n\n");
    const head = rawHead.slice(0, Math.floor(maximum * 0.5));
    const remaining = Math.max(0, maximum - head.length - marker.length - 4);
    return [head, transcript.slice(-remaining), marker].filter(Boolean).join("\n\n").slice(0, maximum);
  }

  _buildCompactedMessages(force = false) {
    const usage = this.contextUsage();
    if (!force && !this._shouldCompactUsage(usage)) return null;
    if (this._messages.length < 2) return null;
    let keepFrom = this._recentTailStart(force);
    if (keepFrom <= this._tailStartIndex || keepFrom >= this._messages.length) return null;
    let summary = this._fallbackSummary(keepFrom);
    let tail = this._messages.slice(keepFrom);
    let estimatedTokens = tokenSize(this, tail) + Math.ceil(summary.length / 4);
    const headTokens = this._lastFrameEntry?.headTokens || 0;
    while (force && headTokens + estimatedTokens >= usage.projectedRequestTokens * 0.9) {
      const next = this._messages.findIndex((message, index) => index > keepFrom && message.role === "user");
      if (next < 0) break;
      keepFrom = next;
      summary = this._fallbackSummary(keepFrom);
      tail = this._messages.slice(keepFrom);
      estimatedTokens = tokenSize(this, tail) + Math.ceil(summary.length / 4);
    }
    return {
      summary,
      fallbackSummary: summary,
      transcript: this._serializeCompactionHead(keepFrom),
      tailStartIndex: keepFrom,
      boundaryMessageId: String(this._messages[keepFrom - 1]?.id || "") || null,
      tailStartMessageId: String(this._messages[keepFrom]?.id || "") || null,
      estimatedTokens,
      beforeTokens: usage.projectedRequestTokens,
    };
  }

  async _summarizeCompaction(candidate, signal) {
    const prior = this._summary ? `Previous rolling summary:\n${this._summary}` : "";
    const state = this._preservePlanBlock();
    const content = [SUMMARY_PROMPT, prior, state, "Conversation history:", candidate.transcript]
      .filter(Boolean)
      .join("\n\n");
    const result = await this._chat([{ role: "user", content }], {
      model: this._model,
      signal,
      timeoutMs: Math.min(30_000, Number(this._config.providerTimeout) || 30_000),
      maxTokens: Math.max(128, Number(this._config.maxCompactedSummarySize) || 4_096),
      tools: [],
      sessionId: this._sessionId,
      streamPhase: "compaction",
      isActive: () => !signal?.aborted,
    });
    const summary = String(result || "").trim();
    if (!summary) throw new Error("Compaction summary was empty.");
    return this._secretStore.redact(summary).slice(0, this._maxSummaryChars());
  }

  _recordCompactedRevision(sourceRevision, record = {}) {
    const previous = this._compactedRevisions.get(sourceRevision);
    this._compactedRevisions.set(sourceRevision, {
      sourceRevision,
      resultRevision: record.resultRevision ?? previous?.resultRevision ?? null,
      beforeTokens: record.beforeTokens ?? previous?.beforeTokens ?? null,
      afterTokens: record.afterTokens ?? previous?.afterTokens ?? null,
      attempt: (previous?.attempt || 0) + 1,
    });
    while (this._compactedRevisions.size > 32) this._compactedRevisions.delete(this._compactedRevisions.keys().next().value);
  }

  _commitCompaction(candidate, sourceRevision) {
    if (!candidate || this._historyRevision !== sourceRevision) return false;
    const beforeTokens = candidate.beforeTokens;
    this._summary = candidate.summary;
    this._tailStartIndex = candidate.tailStartIndex;
    this._usageTracker.bumpHistoryRevision();
    this._historyRevision = this._usageTracker.historyRevision;
    this._recordCompactedRevision(sourceRevision, {
      beforeTokens,
      afterTokens: candidate.estimatedTokens,
      resultRevision: this._historyRevision,
    });
    this._compactedCheckpoint = {
      id: `checkpoint_${randomUUID()}`,
      summary: this._summary,
      boundaryMessageId: candidate.boundaryMessageId,
      tailStartMessageId: candidate.tailStartMessageId,
      createdAt: new Date().toISOString(),
      sourceRevision,
      contextRevision: this._historyRevision,
      estimatedTokens: candidate.estimatedTokens,
      strategyVersion: 2,
    };
    this._redactedMessagesCache = null;
    this._lastFrameEntry = null;
    this._contextCache.reset();
    if (this._latency) {
      this._latency.compactionBeforeTokens = beforeTokens;
      this._latency.compactionAfterTokens = candidate.estimatedTokens;
    }
    return true;
  }

  _compactMessages(force = false) {
    const sourceRevision = this._historyRevision;
    if (this._compactedRevisions.get(sourceRevision)?.attempt >= 1) return false;
    if (this._compactedCheckpoint?.contextRevision === sourceRevision) return false;
    const candidate = this._buildCompactedMessages(force);
    if (!candidate) return false;
    candidate.summary = candidate.fallbackSummary;
    return this._commitCompaction(candidate, sourceRevision);
  }

  _clearCompactionIfStale(activeRun = this._activeRun) {
    if (this._compaction.status === "idle") return;
    const current = activeRun
      && this._compaction.runId === activeRun.runId
      && this._compaction.turnId === activeRun.turnId
      && this._compaction.taskEpoch === activeRun.taskEpoch
      && !activeRun.cancelled
      && !activeRun.finalized;
    if (!current) this._clearCompaction();
  }
}
