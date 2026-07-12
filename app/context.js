import { countTokens } from "../lib/tokens.js";

export class Context {
  constructor(budget = 8000, threshold = 0.7) {
    this._budget = budget;
    this._threshold = threshold;
    this._history = [];
    this._summary = null;
  }

  get usage() {
    const used = this._history.reduce((s, m) => s + countTokens(m.content), 0);
    return { used, budget: this._budget, ratio: used / this._budget };
  }

  async push(msg, summariseFn) {
    this._history.push(msg);
    if (summariseFn && this._needsCompact()) await this._compact(summariseFn);
  }

  _needsCompact() {
    const total = this._history.reduce((s, m) => s + countTokens(m.content), 0);
    return total > this._budget * this._threshold;
  }

  async _compact(summariseFn) {
    if (this._history.length < 4) return;
    try {
      const toSum = this._history.slice(0, -2);
      const summary = await summariseFn(toSum.map(m => m.content).join("\n"));
      if (summary) {
        this._summary = (this._summary ?? "") + " " + summary;
        this._history = this._history.slice(-2);
      }
    } catch {}
  }

  build() {
    const ctx = [];
    if (this._summary) ctx.push({ role: "assistant", content: `[Earlier: ${this._summary}]` });
    let used = this._summary ? countTokens(this._summary) : 0;
    for (const m of this._history) {
      const sz = countTokens(m.content);
      if (used + sz > this._budget) break;
      ctx.push(m);
      used += sz;
    }
    return ctx;
  }

  reset() { this._history = []; this._summary = null; }
}
