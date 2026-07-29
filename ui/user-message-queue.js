import { randomUUID } from "node:crypto";

export class UserMessageQueue {
  constructor(sessionId) {
    this.reset(sessionId);
  }

  reset(sessionId) {
    this.sessionId = String(sessionId || "");
    this.items = [];
    this.activeItemId = null;
    this.processing = false;
    this.exiting = false;
  }

  enqueue(rawContent, displayContent, submittedAt = Date.now()) {
    const item = {
      id: `queued-${randomUUID()}`,
      rawContent: String(rawContent),
      displayContent: String(displayContent),
      submittedAt,
      status: "queued",
    };
    this.items.push(item);
    return item;
  }

  pending() {
    return this.items.filter(item => item.status === "queued");
  }

  pendingCount() {
    return this.pending().length;
  }

  startNext() {
    if (this.exiting || this.processing || this.activeItemId) return null;
    const item = this.items.find(candidate => candidate.status === "queued");
    if (!item) return null;
    item.status = "starting";
    this.activeItemId = item.id;
    this.processing = true;
    return item;
  }

  markRunning(itemId) {
    const item = this.items.find(candidate => candidate.id === itemId);
    if (!item || item.id !== this.activeItemId || item.status !== "starting") return false;
    item.status = "running";
    return true;
  }

  complete(itemId) {
    const item = this.items.find(candidate => candidate.id === itemId);
    if (!item || item.id !== this.activeItemId || item.status !== "running") return false;
    item.status = "completed";
    this._removeActive(itemId);
    return true;
  }

  cancel(itemId) {
    const item = this.items.find(candidate => candidate.id === itemId);
    if (!item || item.id !== this.activeItemId || item.status !== "running") return false;
    item.status = "cancelled";
    this._removeActive(itemId);
    return true;
  }

  _removeActive(itemId) {
    this.items = this.items.filter(candidate => candidate.id !== itemId);
    this.activeItemId = null;
    this.processing = false;
  }

  clearPending() {
    const pending = this.pending();
    for (const item of pending) item.status = "cancelled";
    this.items = this.items.filter(item => item.status !== "cancelled");
    return pending.length;
  }

  markExiting() {
    this.exiting = true;
  }
}

export function formatQueuedMessages(items) {
  if (!items.length) return "No messages are queued.";
  return [
    `Queued messages · ${items.length} pending`,
    ...items.map((item, index) => `${index + 1}. ${item.displayContent.replace(/\s+/g, " ").trim()}`),
  ].join("\n");
}
