import { redactSecrets } from "../lib/secrets.js";

const PLACEHOLDER = /\{\{secret:(secret_\d+)\}\}/g;
const VALUE_PATTERNS = [
  { type: "github_token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { type: "api_key", pattern: /\b(?:sk|pk)[_-](?:live[_-]|test[_-])?[A-Za-z0-9_-]{12,}\b/gi },
  { type: "aws_key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { type: "authorization", pattern: /\bBearer\s+([A-Za-z0-9._~+/-]{12,})\b/gi, group: 1 },
  {
    type: "credential",
    pattern: /\b(?:api[_ -]?key|token|password|credential|secret|cookie|authorization)\s*(?:is\s*)?[:=]\s*["']?([^\s"'&,;]{4,})/gi,
    group: 1,
  },
];

function clone(value, transform) {
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value)) return value.map(entry => clone(entry, transform));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry, transform)]));
  }
  return value;
}

export class SecretStore {
  constructor() {
    this.records = new Map();
    this.activeScope = null;
    this.sequence = 0;
  }

  begin(runId, turnId) {
    this.clear();
    this.activeScope = { runId, turnId };
  }

  isActive(runId, turnId) {
    return this.activeScope?.runId === runId && this.activeScope?.turnId === turnId;
  }

  rebind(runId, turnId) {
    if (!this.activeScope) return false;
    this.activeScope = { runId, turnId };
    for (const record of this.records.values()) {
      record.runId = runId;
      record.turnId = turnId;
    }
    return true;
  }

  capture(content, runId, turnId) {
    this.begin(runId, turnId);
    const rawContent = String(content ?? "");
    const found = [];
    for (const entry of VALUE_PATTERNS) {
      entry.pattern.lastIndex = 0;
      for (const match of rawContent.matchAll(entry.pattern)) {
        const value = match[entry.group || 0];
        if (value && !found.some(secret => secret.value === value)) {
          found.push({ value, type: entry.type });
        }
      }
    }
    found.sort((a, b) => b.value.length - a.value.length);
    for (const secret of found) this.register(secret.value, secret.type, runId, turnId);
    return {
      rawContent,
      protectedContent: this.protect(rawContent, runId, turnId),
      displayContent: this.redact(rawContent),
      detectedSecrets: found.map(secret => secret.type),
      runId,
      turnId,
    };
  }

  register(value, type, runId, turnId) {
    if (!this.isActive(runId, turnId)) return null;
    const existing = [...this.records.values()].find(record => record.value === value);
    if (existing) return existing.secretId;
    const secretId = `secret_${++this.sequence}`;
    this.records.set(secretId, { secretId, value, type, runId, turnId, createdAt: Date.now() });
    return secretId;
  }

  protect(content, runId = this.activeScope?.runId, turnId = this.activeScope?.turnId) {
    let text = String(content ?? "");
    if (!this.isActive(runId, turnId)) return redactSecrets(text);
    const records = [...this.records.values()].sort((a, b) => b.value.length - a.value.length);
    for (const record of records) text = text.split(record.value).join(`{{secret:${record.secretId}}}`);
    return text;
  }

  resolve(content, runId, turnId) {
    const text = String(content ?? "");
    if (!this.isActive(runId, turnId)) return this.redact(text);
    return text.replace(PLACEHOLDER, (placeholder, secretId) => {
      const record = this.records.get(secretId);
      return record?.runId === runId && record?.turnId === turnId ? record.value : "[REDACTED]";
    });
  }

  redact(content) {
    let text = String(content ?? "");
    for (const record of this.records.values()) text = text.split(record.value).join("[REDACTED]");
    return redactSecrets(text.replace(PLACEHOLDER, "[REDACTED]"));
  }

  protectSerializable(value, runId, turnId) {
    return clone(value, text => this.protect(text, runId, turnId));
  }

  resolveSerializable(value, runId, turnId) {
    return clone(value, text => this.resolve(text, runId, turnId));
  }

  redactSerializable(value) {
    return clone(value, text => this.redact(text));
  }

  redactSerializableExcept(value, skipKeys = []) {
    const skip = new Set(skipKeys);
    const cloneSkipping = entry => {
      if (typeof entry === "string") return this.redact(entry);
      if (Array.isArray(entry)) return entry.map(cloneSkipping);
      if (entry && typeof entry === "object") {
        const output = {};
        for (const [key, item] of Object.entries(entry)) {
          if (skip.has(key)) output[key] = item;
          else output[key] = cloneSkipping(item);
        }
        return output;
      }
      return entry;
    };
    return cloneSkipping(value);
  }

  clear(runId, turnId) {
    if (runId && turnId && !this.isActive(runId, turnId)) return false;
    this.records.clear();
    this.activeScope = null;
    return true;
  }

  get size() {
    return this.records.size;
  }
}
