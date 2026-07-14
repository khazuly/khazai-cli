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
  return /^(?:ls|find|rg|grep|pwd|git\s+(?:status|diff|log|show)|node\s+--check|python(?:3)?\s+-c)\b/i.test(text);
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
  if (["web", "websearch", "repo"].includes(name)) {
    kinds.add("inspection");
    kinds.add("research");
  }
  if (["write", "edit", "task"].includes(name)) kinds.add("mutation");
  if (name === "analyze") kinds.add("validation");
  if (name === "bash") {
    const command = args.command;
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
    const kinds = failed ? [] : [...new Set([...evidenceKinds(tool, args), ...extraKinds])];
    const entry = {
      tool,
      args: { ...(args || {}) },
      result: String(result || ""),
      failed: Boolean(failed),
      kinds,
    };
    this.evidence.push(entry);
    if (failed) {
      this.phase = "recovering";
    } else {
      const gaps = this.completionGaps();
      const completed = this.successfulKinds();
      if (gaps.length === 0) this.phase = "ready";
      else if (gaps.includes("validation") && completed.has("mutation")) this.phase = "verifying";
      else this.phase = "executing";
    }
    return entry;
  }

  successfulKinds() {
    return new Set(this.evidence.filter(entry => !entry.failed).flatMap(entry => entry.kinds));
  }

  completionGaps() {
    const actual = this.successfulKinds();
    return this.contract.requiredEvidence.filter(requirement => !actual.has(requirement));
  }

  canComplete() {
    return this.completionGaps().length === 0;
  }

  completionDirective() {
    this.answerAttempts++;
    const labels = {
      mutation: "a successful workspace change",
      deletion: "a successful deletion command",
      inspection: "a successful workspace inspection",
      research: "a successful research tool result",
      validation: "a successful validation or test run",
    };
    const missing = this.completionGaps().map(gap => labels[gap] || gap);
    if (missing.length === 0) this.phase = "completed";
    return missing.length
      ? `The task is not complete. Missing evidence: ${missing.join(", ")}. Choose the next tool from the actual task state and continue.`
      : null;
  }

  contextBlock() {
    const completed = [...this.successfulKinds()];
    const missing = this.completionGaps();
    return [
      `Intent: ${this.contract.intent}`,
      `Phase: ${this.phase}`,
      `Required evidence: ${this.contract.requiredEvidence.join(", ") || "none"}`,
      `Completed evidence: ${completed.join(", ") || "none"}`,
      `Missing evidence: ${missing.join(", ") || "none"}`,
    ].join("\n");
  }
}
