import { fallbackIntentContract, normalizeIntentContract } from "./intent-resolver.js";

export function destructiveCommand(command) {
  const text = String(command || "");
  return /(?:^|[;&|]\s*)\s*(?:rm|unlink|rmdir)\b/i.test(text)
    || /\bfind\b[\s\S]*\s-delete(?:\s|$)/i.test(text)
    || /\bfind\b[\s\S]*-exec\s+(?:rm|unlink|rmdir)\b/i.test(text);
}

export function inspectionCommand(command) {
  if (destructiveCommand(command)) return false;
  const text = String(command || "")
    .replace(/^\s*cd\s+[^;&|]+\s*&&\s*/i, "")
    .trim();
  if (/\b(?:python3?|node)\b/i.test(text) && /\/tmp\//i.test(text)) return true;
  if (/\b(?:python3?|node)\b[\s\S]*\.(?:js|html|json|map)\b/i.test(text)) return true;
  if (
    /(?:^|[\s"'`=:(])\/tmp(?:\/|\b)|\bmktemp\b|\bos\.tmpdir\s*\(|\btmpdir\s*\(/i.test(text)
    && /\b(?:curl|wget|rg|grep|sed|awk|cat|head|tail|find)\b/i.test(text)
    && !/\b(?:rm|unlink|rmdir|mv|cp|install|npm|pnpm|yarn|pip)\b/i.test(text.replace(/\b(?:mkdir\s+-p|tee)\b/gi, ""))
  ) {
    return true;
  }
  if (/\b(?:curl|wget)\b[\s\S]*-o\s+\/tmp\//i.test(text)) return true;
  if (/\b(?:curl|wget)\b[\s\S]*https?:\/\//i.test(text) && !/\b(?:rm|unlink|rmdir|mv|cp)\b/i.test(text)) return true;
  return /^(?:ls|find|rg|grep|cat|head|tail|sed|pwd|curl|wget|git\s+(?:status|diff|log|show)\b|node\s+(?:--check\b|-e\b|-(?:\s|$|<))|python(?:3)?\s+(?:-c\b|-(?:\s|$|<))|python(?:3)?\s+<<)/i.test(text);
}

export function validationCommand(command) {
  const text = String(command || "").trim();
  if (!text || /^(?:npm|pnpm|yarn|pip|pip3)\s+(?:i|install|add)\b/i.test(text)) return false;
  return /\b(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|lint|check|typecheck))\b/i.test(text)
    || /\b(?:pytest|unittest|cargo\s+test|go\s+test|node\s+--test|node\s+--check|py_compile)\b/i.test(text)
    || /\bpython(?:3)?\b[\s\S]*(?:test|pytest|unittest|ast\.parse)\b/i.test(text)
    || /\b(?:eslint|tsc|mypy|ruff|biome)\b/i.test(text);
}

export function inferTaskContract(request) {
  return fallbackIntentContract(request);
}

function evidenceKinds(tool, args = {}) {
  const kinds = new Set();
  const name = String(tool || "");
  if (["read", "glob", "grep", "analyze"].includes(name)) kinds.add("inspection");
  if (["web", "websearch", "webfetch", "repo"].includes(name)) {
    kinds.add("inspection");
    kinds.add("research");
  }
  if (["write", "edit", "apply_patch", "task"].includes(name)) kinds.add("mutation");
  if (name === "analyze") kinds.add("validation");
  if (name === "bash") {
    const command = args.command;
    if (/^\s*git\s+(?:push|fetch|pull|commit|merge|rebase)\b/i.test(String(command || ""))) kinds.add("git");
    if (destructiveCommand(command)) {
      kinds.add("deletion");
      kinds.add("mutation");
    } else if (inspectionCommand(command)) {
      kinds.add("inspection");
    } else {
      kinds.add("mutation");
    }
    if (validationCommand(command)) kinds.add("validation");
  }
  return [...kinds];
}

export class ExecutionPolicy {
  constructor(requestOrContract, { planning = false } = {}) {
    this.contract = typeof requestOrContract === "string"
      ? inferTaskContract(requestOrContract)
      : normalizeIntentContract(requestOrContract, requestOrContract?.request);
    this.phase = planning ? "planning" : "executing";
    this.evidence = [];
    this.answerAttempts = 0;
  }

  setPhase(phase) {
    this.phase = phase;
  }

  record(tool, args, result, failed = false, extraKinds = []) {
    const entry = {
      tool,
      args: { ...(args || {}) },
      result: String(result || ""),
      failed: Boolean(failed),
      kinds: [],
    };
    this.evidence.push(entry);
    this.phase = failed ? "recovering" : "ready";
    return entry;
  }

  successfulKinds() {
    return new Set(this.evidence.filter(entry => !entry.failed).flatMap(entry => entry.kinds));
  }

  completionGaps() {
    return [];
  }

  canComplete() {
    return this.completionGaps().length === 0;
  }

  completionDirective() {
    this.answerAttempts++;
    const steering = this.completionSteering();
    if (!steering) this.phase = "completed";
    return steering ? steering.guidance : null;
  }

  completionSteering() {
    return null;
  }

  contextBlock() {
    const steering = this.completionSteering();
    return [
      `Intent: ${this.contract.intent}`,
      `Phase: ${this.phase}`,
      `Next action: ${steering?.recommendedAction || "the task may be answered"}`,
    ].join("\n");
  }
}
