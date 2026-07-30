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
    this.planning = Boolean(planning);
    this.evidence = [];
    this.answerAttempts = 0;

    // Task-aware state tracking
    this.mutatedWorkspace = false;
    this.ranValidation = false;
    this.ranInspection = false;
    this.ranResearch = false;
    this.ranDeletion = false;
    this.ranGit = false;
    this.toolHistory = [];
  }

  setPhase(phase) {
    this.phase = phase;
  }

  record(tool, args, result, failed = false, extraKinds = []) {
    const computedKinds = [...new Set([...evidenceKinds(tool, args), ...extraKinds])];
    const entry = {
      tool,
      args: { ...(args || {}) },
      result: String(result || ""),
      failed: Boolean(failed),
      kinds: computedKinds,
    };
    this.evidence.push(entry);
    this.toolHistory.push({ tool, failed: entry.failed, kinds: computedKinds });
    if (!failed) {
      if (computedKinds.includes("mutation")) this.mutatedWorkspace = true;
      if (computedKinds.includes("validation")) this.ranValidation = true;
      if (computedKinds.includes("inspection")) this.ranInspection = true;
      if (computedKinds.includes("research")) this.ranResearch = true;
      if (computedKinds.includes("deletion")) this.ranDeletion = true;
      if (computedKinds.includes("git")) this.ranGit = true;
    }
    this.phase = failed ? "recovering" : "ready";
    return entry;
  }

  successfulKinds() {
    const latest = new Map();
    for (const entry of this.evidence) {
      for (const kind of entry.kinds) latest.set(kind, !entry.failed);
    }
    return new Set([...latest].filter(([, succeeded]) => succeeded).map(([kind]) => kind));
  }

  completionGaps() {
    const contract = this.contract;
    if (!contract?.requiredEvidence?.length) return [];
    const successful = this.successfulKinds();
    const gaps = [];
    const requiredEvidence = this.planning
      ? contract.requiredEvidence.filter(kind => ["inspection", "research"].includes(kind))
      : contract.requiredEvidence;
    for (const required of requiredEvidence) {
      if (!successful.has(required)) {
        gaps.push({ kind: required, description: `Missing required evidence: ${required}` });
      }
    }
    return gaps;
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
    const gaps = this.completionGaps();
    if (gaps.length === 0) return null;

    const category = this.contract.category;
    const gapKinds = gaps.map(g => g.kind);

    const categoryGuidance = {
      MODIFICATION: {
        missingMutation: {
          recommendedAction: "inspect the target and apply the smallest targeted edit or patch",
          guidance: "Continue the requested code change. Preserve unrelated code and run requested validation after the patch.",
        },
        missingValidation: {
          recommendedAction: "run the relevant test or validation command and address failures",
          guidance: "Run the appropriate validation (test, lint, typecheck) after the code change to verify correctness.",
        },
        missingInspection: {
          recommendedAction: "inspect the relevant files or directories before making changes",
          guidance: "Read the relevant source files to understand the current structure before editing.",
        },
      },
      TESTING: {
        missingValidation: {
          recommendedAction: "run the relevant test or validation and recover from its result",
          guidance: "Continue the active testing task with the relevant command, then address any observed failure.",
        },
        missingMutation: {
          recommendedAction: "apply the necessary fix and then re-run the validation",
          guidance: "After applying a fix, re-run the test suite to confirm the issue is resolved.",
        },
      },
      GIT_OPERATION: {
        missingGit: {
          recommendedAction: "resume the pending Git command or resolve remote, branch, upstream, or authentication",
          guidance: "Continue the pending Git operation from its last result. Ask cleanly for credentials only when authentication is required.",
        },
      },
      INSPECTION: {
        missingInspection: {
          recommendedAction: "perform the relevant read or search",
          guidance: "Continue the inspection until there is enough relevant information to answer the user.",
        },
      },
      RESEARCH: {
        missingResearch: {
          recommendedAction: "retry the relevant fetch or use a safe fallback",
          guidance: "Continue the active web analysis from the last fetch result instead of ending the task early.",
        },
      },
      DESTRUCTIVE_OPERATION: {
        missingDeletion: {
          recommendedAction: "confirm and execute the deletion",
          guidance: "Execute the requested deletion after confirming scope. Only delete what was requested.",
        },
      },
    };

    const categoryGuidanceMap = categoryGuidance[category] || {};
    for (const kind of gapKinds) {
      const guidance = categoryGuidanceMap[kind];
      if (guidance) {
        return {
          detectedIntent: this.contract.intent,
          proposedAction: `early completion with missing ${kind} evidence`,
          recommendedAction: guidance.recommendedAction,
          guidance: guidance.guidance,
        };
      }
    }

    // Fallback: generic guidance for any remaining gap
    return {
      detectedIntent: this.contract.intent,
      proposedAction: `early completion with missing evidence: ${gapKinds.join(", ")}`,
      recommendedAction: `continue gathering the required ${gapKinds[0]} evidence`,
      guidance: `Continue the task to collect the missing evidence (${gapKinds.join(", ")}) before providing a final answer.`,
    };
  }

  contextBlock() {
    const gaps = this.completionGaps();
    const steering = this.completionSteering();
    const flags = [
      this.mutatedWorkspace ? "mutated" : null,
      this.ranValidation ? "validated" : null,
      this.ranInspection ? "inspected" : null,
      this.ranResearch ? "researched" : null,
    ].filter(Boolean);

    return [
      `Intent: ${this.contract.intent}`,
      `Category: ${this.contract.category}`,
      `Phase: ${this.phase}`,
      `Required evidence: ${this.contract.requiredEvidence?.join(", ") || "none"}`,
      `Collected: ${flags.join(", ") || "none"}`,
      gaps.length ? `Missing: ${gaps.map(g => g.kind).join(", ")}` : null,
      `Next action: ${steering?.recommendedAction || "the task may be answered"}`,
    ].filter(Boolean).join("\n");
  }
}
