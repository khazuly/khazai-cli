import { randomUUID } from "node:crypto";
import { hydrateCanonicalMessages } from "../session-hydration.js";

export class RuntimeMethods {
  admitRun(objective, scope = {}) {
    this._durableRun = {
      version: 1,
      status: scope.resumeRun ? "resuming" : "running",
      runId: String(scope.runId || randomUUID()),
      turnId: String(scope.turnId || randomUUID()),
      taskEpoch: Number(scope.taskEpoch) || 0,
      objective: this._secretStore.redact(String(scope.resumeRun?.objective || objective || "")),
      mode: scope.mode === "plan" ? "plan" : "build",
      model: this._model,
      phase: "admitted",
      startedAt: scope.resumeRun?.startedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedCallIds: this._lifecycle.parts
        .filter(part => part.type === "tool" && part.state?.status === "completed")
        .map(part => String(part.callId)),
    };
    return this.exportSessionState();
  }

  interruptedRun() {
    if (!["running", "resuming", "interrupted"].includes(this._durableRun?.status)) return null;
    return { ...this._durableRun, status: "interrupted" };
  }

  activeRunState() {
    if (!this._durableRun) return null;
    return {
      ...this._durableRun,
      completedCallIds: this._lifecycle.parts
        .filter(part => part.type === "tool" && part.state?.status === "completed")
        .map(part => String(part.callId)),
    };
  }

  markRunInterrupted() {
    if (!["running", "resuming"].includes(this._durableRun?.status)) return;
    this._durableRun = {
      ...this._durableRun,
      status: "interrupted",
      phase: "interrupted",
      updatedAt: new Date().toISOString(),
    };
  }

  _updateDurableRun(patch = {}) {
    if (!this._durableRun || ["completed", "failed"].includes(this._durableRun.status)) return;
    this._durableRun = { ...this._durableRun, ...patch, updatedAt: new Date().toISOString() };
  }

  _appendMessage(message) {
    const candidate = message?.id ? message : { ...message, id: `message_${randomUUID()}` };
    const hydrated = hydrateCanonicalMessages([candidate]).messages[0] || candidate;
    this._messages.push(hydrated);
    this._usageTracker.bumpHistoryRevision();
    this._historyRevision = this._usageTracker.historyRevision;
    this._lastFrameEntry = null;
    return hydrated;
  }

  _storedOutputReference(callId) {
    return `khazai-output:${String(callId || "")}`;
  }

  _conciseToolContent(name, callId, content) {
    const preview = Math.max(0, Number(this._config.toolResultPreviewSize) || 0);
    const text = String(content ?? "");
    if (preview <= 0 || text.length <= preview) return { stored: text, concise: text, truncated: false };
    const reference = this._storedOutputReference(callId);
    const concise = `[Tool result: ${name} · stored output ${reference}]\n${text.slice(0, preview)}\n…(full output available as ${reference})`;
    return { stored: text, concise, truncated: true, reference };
  }

  _pushToolMessage(name, callId, content) {
    const { stored, concise, truncated } = this._conciseToolContent(name, callId, content);
    if (truncated) {
      this._storedToolResults.set(String(callId || ""), stored);
      while (this._storedToolResults.size > 200) this._storedToolResults.delete(this._storedToolResults.keys().next().value);
    }
    this._appendMessage({ role: "tool", tool_call_id: callId, name, content: concise });
    return stored;
  }

  _contextCacheKey() {
    return [`m:${this._model}`, "t:chars4", `r:${this._historyRevision}`, `s:${this._tailStartIndex}`].join("|");
  }

  _reservedOutputHeadroom() {
    const configured = Number(this._config?.reservedOutputHeadroom);
    if (Number.isFinite(configured) && configured > 0) return configured;
    const effective = this._applyEffectiveSettings();
    if (!effective.contextLimit) return 0;
    const requested = Number(effective.maxOutputTokens) || Math.floor(effective.contextLimit * 0.05);
    return Math.max(2_048, Math.min(8_192, requested));
  }

  _frame() {
    const effective = this._applyEffectiveSettings();
    const sys = this._buildSystem();
    const activeObjective = [
      "ACTIVE TASK FOR THIS TURN:",
      String(this._activeScope?.objective || this._currentRequest || ""),
      "Treat every earlier task as completed historical context unless this user message explicitly requests continuation.",
    ].join("\n");
    const limit = effective.contextLimit || 0;
    const key = this._contextCacheKey();
    const entry = this._contextCache.buildFrame(key, {
      messages: this._messages,
      requestStartIndex: limit > 0 ? this._requestStartIndex : this._tailStartIndex,
      tailStartIndex: this._tailStartIndex,
      limit,
      sys,
      activeObjective,
      summary: this._summary,
    });
    this._lastFrameEntry = entry;
    this._lastFrameKey = key;
    return entry;
  }
}
