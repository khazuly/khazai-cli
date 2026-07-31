import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { inspectionCommand } from "./execution-policy.js";

export const PLAN_ACTIONS = [
  {
    id: "implement",
    label: "Implement this plan now",
    description: "Switch to Build Mode and execute the approved plan.",
    recommended: true,
  },
  {
    id: "revise",
    label: "Revise the plan",
    description: "Keep the investigation and revisit the plan decisions.",
  },
  {
    id: "question",
    label: "Ask another question",
    description: "Keep the draft plan and return to planning input.",
  },
  {
    id: "save",
    label: "Save the plan without implementing",
    description: "Store the plan in session history and return to the default mode.",
  },
  {
    id: "cancel",
    label: "Cancel",
    description: "Exit Plan Mode without modifying files.",
  },
];

export const REVALIDATION_ACTIONS = [
  {
    id: "revalidate",
    label: "Revalidate and continue",
    description: "Refresh changed file snapshots while preserving approved decisions.",
    recommended: true,
  },
  {
    id: "plan",
    label: "Return to Plan Mode",
    description: "Reopen planning and inspect what changed.",
  },
  {
    id: "cancel",
    label: "Cancel",
    description: "Exit without applying modifications.",
  },
];

export function planToolIsReadOnly(call, definition = null) {
  const name = String(call?.name || "");
  if (["read", "glob", "grep", "websearch", "webfetch", "question", "think", "skill", "todowrite"].includes(name)) {
    return true;
  }
  if (name.startsWith("mcp__")) return definition?.mcp?.readOnly === true;
  if (name !== "bash") return false;
  const command = String(call.args?.command || "");
  if (
    /(?:^|[;&|]\s*)\s*(?:touch|mkdir|rm|rmdir|unlink|cp|mv|install|tee|truncate|chmod|chown|ln)\b/i.test(command)
    || /\b(?:npm|pnpm|yarn|bun|pip|pip3)\s+(?:install|add|remove|uninstall|update)\b/i.test(command)
    || /\bgit\s+(?:add|commit|push|pull|merge|rebase|reset|checkout|clean|stash|switch|restore)\b/i.test(command)
    || /\b(?:mktemp|sed\s+-i|curl\b[\s\S]*\s-o\b|wget\b[\s\S]*\s-O\b)\b/i.test(command)
    || /\b(?:node|python3?)\s+(?:-e|-c|<<)\b/i.test(command)
  ) return false;
  const withoutSafeDevices = command.replace(
    /(?:^|\s)\d*(?:>>?|<)\s*\/dev\/(?:null|stdin|stdout|stderr|fd\/\d+)\b/g,
    " ",
  );
  if (/(?:^|\s)\d*(?:>>?)\s*[^\s&]/.test(withoutSafeDevices)) return false;
  const segments = command.split(/\s*(?:&&|\|\||;)\s*/).map(s => s.trim()).filter(Boolean);
  if (segments.length > 1) {
    return segments.every(segment => inspectionCommand(segment));
  }
  return inspectionCommand(command);
}

function hashFile(path) {
  if (!existsSync(path) || !statSync(path).isFile()) return { exists: false, hash: null, mtimeMs: null };
  const stat = statSync(path);
  return {
    exists: true,
    hash: createHash("sha256").update(readFileSync(path)).digest("hex"),
    mtimeMs: stat.mtimeMs,
  };
}

function workspaceFiles(workspace, files) {
  const root = resolve(workspace);
  return [...new Set((files || []).map(file => resolve(root, String(file))).filter(path => {
    const local = relative(root, path);
    return local && !local.startsWith("..") && !resolve(path).startsWith(`${root}/node_modules/`);
  }))];
}

export function createPlanModeState({ objective, runId, turnId, taskEpoch }) {
  return {
    planId: randomUUID(),
    runId,
    turnId,
    taskEpoch,
    mode: "plan",
    status: "investigating",
    objective: String(objective || "").trim(),
    decisions: [],
    relevantFiles: [],
    codeAreas: [],
    steps: [],
    risks: [],
    verification: [],
    summary: "",
    fileSnapshots: {},
    createdAt: Date.now(),
    approvedAt: null,
  };
}

export function planScopeMatches(plan, scope) {
  return Boolean(
    plan
    && scope
    && plan.runId === scope.runId
    && plan.turnId === scope.turnId
    && plan.taskEpoch === scope.taskEpoch
  );
}

export function recordPlanDecision(plan, question, answer) {
  if (!plan || plan.status === "approved" || plan.status === "cancelled") return plan;
  const decision = {
    questionId: String(question.questionId || question.question || `question-${plan.decisions.length + 1}`),
    question: String(question.question || ""),
    optionId: String(answer?.id || ""),
    answer: String(answer?.label || answer || "").trim(),
    custom: Boolean(answer?.custom),
  };
  const decisions = plan.decisions.filter(item => item.questionId !== decision.questionId);
  return { ...plan, status: "investigating", decisions: [...decisions, decision] };
}

export function finalizePlanMode(plan, {
  workspace,
  summary,
  relevantFiles,
  steps,
}) {
  const files = workspaceFiles(workspace, relevantFiles);
  return {
    ...plan,
    status: "reviewing",
    summary: String(summary || "").trim(),
    relevantFiles: files.map(path => relative(resolve(workspace), path)),
    steps: (steps || []).map(item => String(item.description || item.content || item)).filter(Boolean),
    fileSnapshots: Object.fromEntries(files.map(path => [relative(resolve(workspace), path), hashFile(path)])),
  };
}

export function approvePlanMode(plan) {
  if (!plan || plan.status !== "reviewing" || plan.approvedAt) return null;
  return structuredClone({
    ...plan,
    mode: "build",
    status: "approved",
    approvedAt: Date.now(),
  });
}

export function changedPlanFiles(plan, workspace) {
  return Object.entries(plan?.fileSnapshots || {}).filter(([path, snapshot]) => {
    const current = hashFile(resolve(workspace, path));
    return current.exists !== snapshot.exists || current.hash !== snapshot.hash;
  }).map(([path]) => path);
}

export function refreshPlanSnapshots(plan, workspace) {
  const root = resolve(workspace);
  return {
    ...plan,
    fileSnapshots: Object.fromEntries(
      (plan.relevantFiles || []).map(path => [path, hashFile(resolve(root, path))]),
    ),
  };
}

export function approvedPlanRequest(plan) {
  const decisions = plan.decisions.length
    ? plan.decisions.map(item => `- ${item.question}: ${item.answer}`).join("\n")
    : "- No additional user decisions were required.";
  const files = plan.relevantFiles.length
    ? plan.relevantFiles.map(path => `- ${path}`).join("\n")
    : "- Revalidate the specific files named in the approved plan.";
  const steps = plan.steps.length
    ? plan.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")
    : "- Follow the implementation steps in the approved plan summary.";
  return [
    "Implement the approved plan below. This is a fresh Build Mode run.",
    `Plan ID: ${plan.planId}`,
    `Objective: ${plan.objective}`,
    "Preserve the approved scope and decisions. Re-read only the relevant files before editing.",
    "Start by mirroring the approved implementation steps with todowrite in pending state.",
    "Update each plan item only from actual tool and verification results.",
    "",
    "Approved decisions:",
    decisions,
    "",
    "Relevant files:",
    files,
    "",
    "Implementation steps:",
    steps,
    "",
    "Approved plan:",
    plan.summary,
  ].join("\n");
}
