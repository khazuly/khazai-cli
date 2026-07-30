import { countTokens } from "../lib/tokens.js";
import { resolveModelDescriptor } from "../lib/llm.js";

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/**
 * Resolve context limit for a model using priority:
 * 1. Verified provider/model metadata from the provider response
 * 2. Trusted user configuration: config.models[modelName].contextLimit
 * 3. Trusted user configuration: config.contextLimit
 * 4. Unknown (null)
 *
 * Returns { limit, source } where source is "provider" | "config" | "unknown".
 */
export function resolveContextLimit(model, config) {
  let descriptor;
  try {
    descriptor = resolveModelDescriptor(model, config);
  } catch {
    descriptor = null;
  }
  const definition = descriptor?.definition || {};
  const metadata = config?.modelMetadata?.[descriptor?.exactID]
    || config?.modelMetadata?.[descriptor?.modelID]
    || {};

  // 1. Provider/metadata limit
  const fromMetadata = positive(metadata.contextLimit)
    || positive(definition.contextLimit)
    || positive(definition.contextLimits?.[descriptor?.modelID]);
  if (fromMetadata) return { limit: fromMetadata, source: "provider" };

  // 2. Trusted config.models[modelName].contextLimit
  const modelName = descriptor?.requested || model;
  const fromConfig = positive(config?.models?.[modelName]?.contextLimit)
    || positive(config?.contextLimit);
  if (fromConfig) return { limit: fromConfig, source: "config" };

  // 3. Unknown
  return { limit: null, source: "unknown" };
}

/**
 * Shortcut: returns just the numeric limit or null.
 */
export function resolveContextLimitValue(model, config) {
  const resolved = resolveContextLimit(model, config);
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
    // Only add deltas when this is a new entry or values changed
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
  } = {}) {
    const recounted = countProviderContext(messages);
    const activeCompaction = ["scheduled", "preparing", "summarizing", "committing", "recounting"]
      .includes(compactionStatus);
    const currentContextTokens = activeCompaction && Number.isFinite(stableTokens)
      ? stableTokens
      : recounted;
    const projectedRequestTokens = currentContextTokens
      + Math.max(512, Math.min(4_096, Math.ceil(currentContextTokens * 0.1)));
    const known = Boolean(positive(contextLimit));
    const usageRatio = known ? currentContextTokens / contextLimit : null;
    const usagePercent = known
      ? Math.min(100, Math.max(0, usageRatio * 100))
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
