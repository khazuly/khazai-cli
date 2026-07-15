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
    const steering = this.completionSteering();
    if (!steering) this.phase = "completed";
    // Kept for callers that need a truthy completion guard. This value is
    // orchestration-only and must never be rendered as an assistant answer.
    return steering ? steering.guidance : null;
  }

  completionSteering() {
    const gaps = this.completionGaps();
    if (gaps.length === 0) return null;

    const category = this.contract.category;
    const byCategory = {
      GIT_OPERATION: {
        recommendedAction: "resume the pending Git command or resolve its remote, branch, upstream, or authentication problem",
        guidance: "Continue the pending Git operation using its last command result. If authentication is required, request credentials cleanly; otherwise run the relevant Git recovery command.",
      },
      MODIFICATION: {
        recommendedAction: gaps.includes("validation") ? "run the relevant validation for the applied change" : "inspect the target and apply a minimal targeted edit",
        guidance: "Continue the active code change. Preserve unrelated code and use a targeted edit or patch; then run any requested validation.",
      },
      TESTING: {
        recommendedAction: "run the relevant test, build, lint, or validation command",
        guidance: "Continue the active validation task. Run the relevant check and use its result to choose the next recovery step.",
      },
      INSPECTION: {
        recommendedAction: "perform the relevant read, search, or inspection",
        guidance: "Continue the active inspection until the requested information is supported by a relevant tool result.",
      },
      RESEARCH: {
        recommendedAction: "retry the relevant fetch or use a safe research fallback",
        guidance: "Continue the active fetch or research task from its last result, using a relevant retry or fallback.",
      },
      DESTRUCTIVE_OPERATION: {
        recommendedAction: "perform the requested deletion command safely",
        guidance: "Continue the requested deletion task with the specific safe command and verify its result.",
      },
    };
    return {
      needsSteering: true,
      detectedIntent: category || this.contract.intent,
      proposedAction: "final response before the active task has finished",
      ...(byCategory[category] || {
        recommendedAction: "take the next action required by the active task",
        guidance: "Continue from the active task state and last tool result before giving a final response.",
      }),
    };
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
