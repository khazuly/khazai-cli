import { countTokens } from "../lib/tokens.js";
import { resolveEffectiveSettings } from "../config/model-settings.js";

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function resolveContextLimit(model, config, options = {}) {
  const effective = resolveEffectiveSettings(model, {
    config,
    sessionOverrides: options.sessionOverrides,
    providerMetadata: options.providerMetadata,
  });
  return {
    limit: positive(effective.contextLimit),
    source: effective.contextLimitSource,
  };
}

export function resolveContextLimitValue(model, config, options = {}) {
  const resolved = resolveContextLimit(model, config, options);
  return resolved.limit;
}

export function countProviderContext(messages) {
  return countTokens(JSON.stringify(Array.isArray(messages) ? messages : []));
}

function normalizedUsage(event) {
  const input = Number(event?.inputTokens ?? event?.promptTokens ?? 0);
  const output = Number(event?.outputTokens ?? event?.completionTokens ?? 0);
  return {
    inputTokens: Number.isFinite(input) && input >= 0 ? input : 0,
    outputTokens: Number.isFinite(output) && output >= 0 ? output : 0,
  };
}

export class ContextUsageTracker {
  constructor(state = null) {
    this.requests = new Map();
    this._turnInputTokens = 0;
    this._turnOutputTokens = 0;
    this._sessionInputTokens = 0;
    this._sessionOutputTokens = 0;
    this._historyRevision = 0;
    for (const entry of state?.requests || []) {
      if (entry?.key) this.requests.set(entry.key, normalizedUsage(entry));
    }
    if (state?.sessionInputTokens !== undefined) this._sessionInputTokens = state.sessionInputTokens;
    if (state?.sessionOutputTokens !== undefined) this._sessionOutputTokens = state.sessionOutputTokens;
    if (state?.historyRevision !== undefined) this._historyRevision = state.historyRevision;
  }

  get historyRevision() { return this._historyRevision; }

  bumpHistoryRevision() { this._historyRevision++; }

  record(event, scope) {
    if (!event?.requestId || !scope?.runId || !scope?.turnId) return false;
    const key = `${scope.runId}:${scope.turnId}:${event.requestId}`;
    const previous = this.requests.get(key);
    const usage = normalizedUsage(event);
    this.requests.set(key, usage);
    if (previous) {
      this._turnInputTokens += usage.inputTokens - previous.inputTokens;
      this._turnOutputTokens += usage.outputTokens - previous.outputTokens;
      this._sessionInputTokens += usage.inputTokens - previous.inputTokens;
      this._sessionOutputTokens += usage.outputTokens - previous.outputTokens;
    } else {
      this._turnInputTokens += usage.inputTokens;
      this._turnOutputTokens += usage.outputTokens;
      this._sessionInputTokens += usage.inputTokens;
      this._sessionOutputTokens += usage.outputTokens;
    }
    return true;
  }

  resetTurn() {
    this._turnInputTokens = 0;
    this._turnOutputTokens = 0;
  }

  totals() {
    return {
      sessionInputTokens: this._sessionInputTokens,
      sessionOutputTokens: this._sessionOutputTokens,
    };
  }

  turnTotals() {
    return {
      currentTurnInputTokens: this._turnInputTokens,
      currentTurnOutputTokens: this._turnOutputTokens,
    };
  }

  snapshot(messages, contextLimit, {
    estimated = true,
    compactionStatus = "idle",
    compactionStartedAt = null,
    stableTokens = null,
    historyRevision,
    contextTokens = null,
    outputHeadroom = 0,
  } = {}) {
    const recounted = Number.isFinite(contextTokens) && contextTokens >= 0
      ? contextTokens
      : countProviderContext(messages);
    const activeCompaction = ["scheduled", "preparing", "summarizing", "committing", "recounting"]
      .includes(compactionStatus);
    const currentContextTokens = activeCompaction && Number.isFinite(stableTokens)
      ? stableTokens
      : recounted;
    const projectedRequestTokens = currentContextTokens
      + Math.max(512, Math.min(4_096, Math.ceil(currentContextTokens * 0.1)));
    const known = Boolean(positive(contextLimit));
    const reservedOutputHeadroom = known
      ? Math.max(0, Math.min(contextLimit - 1, Math.floor(Number(outputHeadroom) || 0)))
      : 0;
    const usableContextTokens = known ? Math.max(1, contextLimit - reservedOutputHeadroom) : null;
    const usageRatio = known ? currentContextTokens / contextLimit : null;
    const usagePercent = known
      ? Math.min(100, Math.max(0, usageRatio * 100))
      : null;
    const usableRatio = usableContextTokens !== null
      ? projectedRequestTokens / usableContextTokens
      : null;
    return {
      currentContextTokens,
      projectedRequestTokens,
      currentTurnInputTokens: this._turnInputTokens,
      currentTurnOutputTokens: this._turnOutputTokens,
      ...this.totals(),
      ...this.turnTotals(),
      contextLimit: known ? contextLimit : null,
      contextLimitKnown: known,
      contextLimitSource: known ? (this._contextLimitSource || "unknown") : "unknown",
      usableContextTokens,
      reservedOutputHeadroom,
      usableRatio,
      usageRatio,
      usagePercent,
      estimated,
      compactionStatus,
      compactionStartedAt,
      historyRevision: historyRevision ?? this._historyRevision,
    };
  }

  setContextLimitSource(source) {
    this._contextLimitSource = source;
  }

  export() {
    return {
      requests: [...this.requests].map(([key, usage]) => ({ key, ...usage })),
      sessionInputTokens: this._sessionInputTokens,
      sessionOutputTokens: this._sessionOutputTokens,
      historyRevision: this._historyRevision,
    };
  }
}
