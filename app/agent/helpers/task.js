import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cleanInteractiveText } from "../../../lib/interactive-text.js";
import { isProviderParseFailure } from "./parser.js";

export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function workspaceMetadata(workspace) {
  const workingDirectory = resolve(workspace);
  let cursor = workingDirectory;
  while (true) {
    if (existsSync(join(cursor, ".git"))) {
      return { workingDirectory, worktree: cursor, isGitRepo: true };
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      return { workingDirectory, worktree: workingDirectory, isGitRepo: false };
    }
    cursor = parent;
  }
}

export const PARALLEL_READ_ONLY_TOOLS = new Set([
  "read", "glob", "grep", "analyze", "repo", "websearch", "webfetch", "lsp",
]);

export const INSPECTION_TOOLS = new Set(["read", "glob", "grep", "analyze"]);
export const IDEMPOTENT_MUTATION_TOOLS = new Set(["write", "edit", "apply_patch"]);
export const MAX_LOOP_RECOVERIES = 4;

export function sourceUrls(value) {
  return [...String(value || "").matchAll(/https?:\/\/[^\s<>"')\]]+/g)]
    .map(match => match[0].replace(/[.,;:]$/, ""))
    .filter((url, index, all) => all.indexOf(url) === index);
}

export function deterministicIdentityAnswer(input) {
  const source = String(input || "").trim();
  if (/^(?:halo|hai|assalamu['’]?alaikum)[\s!,.?]*$/i.test(source)) {
    return "Hello! I'm KhazAI. How can I help?";
  }
  if (/\b(?:who are you|what(?:'s| is) your name|siapa kamu|siapa anda|nama kamu siapa|kamu siapa)\b/i.test(source)) {
    return "I'm KhazAI, a coding agent that can inspect, modify, and validate projects.";
  }
  return null;
}

export function extractPlan(text) {
  const items = [];
  const re = /\[\s*([ .xX])\s*\]\s+(.+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const ch = m[1];
    items.push({
      status: ch === "x" || ch === "X" ? "done" : "pending",
      description: m[2].trim(),
    });
  }
  return items;
}

export function normalizePlan(items) {
  const observable = items.filter(item => {
    const description = item.description.toLowerCase();
    const reasoningOnly = /\b(deduplicat|categor(?:y|ize)|summari[sz]e|compile (?:the )?(?:results|findings)|prepare (?:the )?(?:report|response)|present (?:the )?(?:results|findings)|report (?:the )?(?:results|findings))\b/i.test(description);
    const hasObservableAction = /\b(fetch|search|open|inspect|read|list|scan|analy[sz]e|create|write|edit|implement|fix|run|test|validate|install)\b/i.test(description);
    return !reasoningOnly || hasObservableAction;
  });
  return observable.length ? observable : items;
}

export function requiresPlan(contract) {
  return Boolean(contract?.requiresPlan);
}

export function fallbackPlan(contract) {
  if (["inspect", "research"].includes(contract?.intent)) {
    if (["research", "discover_endpoints"].includes(contract?.operation)) {
      return [
        { status: "pending", description: "Fetch the target URL and understand the page structure" },
        { status: "pending", description: "Look for JavaScript bundle references in the HTML" },
        { status: "pending", description: "Download and inspect bundles for API patterns" },
        { status: "pending", description: "Test endpoints before generating code" },
        { status: "pending", description: "Document required headers, cookies, and payload structure" },
      ];
    }
    return [
      { status: "pending", description: "Inspect the requested sources" },
      { status: "pending", description: "Validate the relevant findings" },
    ];
  }
  const sampleExtensions = requestedSampleExtensions(contract);
  if (sampleExtensions.length > 0) {
    const plan = [
      { status: "pending", description: "Inspect the relevant workspace files and requirements" },
      ...sampleExtensions.map(extension => ({ status: "pending", description: `Create the requested ${extension} sample file` })),
    ];
    if (needsExecutionValidation(contract)) {
      plan.push({ status: "pending", description: "Run the requested samples and validate the result" });
    }
    return plan;
  }
  return [
    { status: "pending", description: "Inspect the relevant workspace files and requirements" },
    { status: "pending", description: "Implement the requested changes" },
    { status: "pending", description: "Validate the result and report completion" },
  ];
}

export function extractInteractiveQuestion(text) {
  const lines = String(text).split("\n").map(cleanInteractiveText).filter(Boolean);
  const optionPattern = /^(?:[-*•]|\d+[.)])\s+(.+)$/;
  const firstOption = lines.findIndex(line => optionPattern.test(line));
  const promptLines = firstOption === -1 ? lines : lines.slice(0, firstOption);
  const questionLine = promptLines.findLast(line => /\?$/.test(line));
  const options = (firstOption === -1 ? lines : lines.slice(firstOption))
    .map(line => optionPattern.exec(line)?.[1]?.trim())
    .filter(Boolean)
    .filter((option, index, all) => all.indexOf(option) === index)
    .slice(0, 6);
  const hasQuestionCue = /\b(what|which|please|provide|choose|select|would you|do you|can you|apakah|pilih|yakin|ingin|mau)\b/i.test(questionLine || "");
  if (!questionLine || (!hasQuestionCue && options.length < 2)) return null;
  return { question: promptLines.join("\n"), options };
}

export function toolSignature(tool, workspace = "") {
  const args = { ...tool.args };
  delete args._agentWorkspace;
  if (args.path && !String(args.path).startsWith("/") && workspace) {
    args.path = resolve(workspace, String(args.path));
  }
  if (["glob", "grep"].includes(tool.name) && !args.path && workspace) args.path = workspace;
  if (tool.name === "bash" && typeof args.command === "string") {
    args.command = args.command.trim().replace(/\s+/g, " ");
  }
  return JSON.stringify({ tool: tool.name, args });
}

export function publicToolArgs(args = {}) {
  return Object.fromEntries(
    Object.entries(args || {}).filter(([key]) => !key.startsWith("_")),
  );
}

export function repeatedToolCycle(signatures, maximumPeriod = 4, repetitions = 3) {
  for (let period = 1; period <= maximumPeriod; period++) {
    const required = period * repetitions;
    if (signatures.length < required) continue;
    const tail = signatures.slice(-required);
    const pattern = tail.slice(0, period);
    if (tail.every((signature, index) => signature === pattern[index % period])) {
      return pattern;
    }
  }
  return null;
}

export function cachedToolAnswer(tool, result) {
  const text = String(result || "").trim();
  const found = /^Found\s+(\d+)(?:\s*\([^)]*\))?:\n([\s\S]+)$/i.exec(text);
  if (tool.name === "glob" && found) {
    return `Found ${found[1]} files.`;
  }
  if (tool.name === "grep" && found) {
    return `Found ${found[1]} matches.`;
  }
  const noFiles = /^No files matching\s+"([^"]*)"\s+in\s+(.+)$/i.exec(text);
  if (tool.name === "glob" && noFiles) {
    const [, pattern, path] = noFiles;
    return pattern === "*"
      ? `The folder ${path} is empty. There are no files inside it.`
      : `No files match "${pattern}" in ${path}.`;
  }
  if (tool.name === "grep" && /^No matches/i.test(text)) {
    return "No matching results were found.";
  }
  const preview = text.slice(0, 3000);
  return `Inspection completed.\n${preview}`;
}

export function requestMode(contract) {
  if (contract?.category === "GIT_OPERATION" || contract?.operation === "git") return "neutral";
  if (["change", "delete"].includes(contract?.intent) || contract?.category === "MODIFICATION") return "mutate";
  if (["answer", "inspect", "research", "unknown"].includes(contract?.intent)) return "read-only";
  return "neutral";
}

export function declaredSymbols(source) {
  const symbols = new Set();
  const text = String(source || "");
  for (const match of text.matchAll(/\b(?:class|def|function)\s+([A-Za-z_$][\w$]*)/g)) symbols.add(match[1]);
  return [...symbols];
}

export function preservesImplementationStructure(existing, candidate) {
  const symbols = declaredSymbols(existing);
  if (symbols.length === 0) return true;
  const retained = symbols.filter(symbol => new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(candidate));
  return retained.length >= Math.ceil(symbols.length * 0.6);
}

export function prospectiveFileContent(tool, existing) {
  if (tool.name === "write") return String(tool.args?.content || "");
  if (tool.name !== "edit") return null;
  const oldString = String(tool.args?.oldString ?? "");
  if (!oldString || !existing.includes(oldString)) return null;
  return existing.replace(oldString, String(tool.args?.newString ?? ""));
}

export function shouldDeferToolCandidateProse(contract, hasPendingPlan) {
  return Boolean(hasPendingPlan || contract?.intent !== "answer" || contract?.targetUrl);
}

export function wantsFileCount(contract) {
  return contract?.operation === "count_files";
}

export function simpleFileListRequest(contract) {
  return contract?.operation === "list_files";
}

export function fileCountFromToolResult(tool, result) {
  const text = String(result || "");
  if (resultFailed(text)) return null;
  if (tool.name === "glob") {
    const found = /^Found\s+(\d+)/im.exec(text);
    return found ? Number(found[1]) : null;
  }
  if (tool.name !== "bash" || !/\bwc\s+-l\b/i.test(String(tool.args?.command || ""))) return null;
  const lines = text.split("\n").map(line => line.trim()).filter(Boolean);
  const numeric = lines.findLast(line => /^\d+$/.test(line));
  return numeric === undefined ? null : Number(numeric);
}

export function resultFailed(result) {
  const text = String(result || "");
  return text.startsWith("Error")
    || text.startsWith("Syntax validation")
    || /^Exit:\s*(?!0\b)-?\d+/m.test(text);
}

export function isSteeringOutcome(value) {
  return isObject(value) && value.needsSteering === true;
}

export function legacyGuardOutcome(value, tool, contract) {
  const text = String(value || "");
  if (!/^(?:BLOCKED|Stopped:|Denied|Safety violation)\b/i.test(text)) return null;
  return {
    needsSteering: true,
    detectedIntent: contract?.category || "UNKNOWN",
    proposedAction: tool?.name || "tool action",
    recommendedAction: "the next safe action for the active task",
    guidance: "The previous action was not permitted. Keep the active task and choose the matching safe tool action instead.",
  };
}

export function guardErrorOutcome(error, tool) {
  const detail = String(error?.message || error || "");
  if (/access denied|not allowed|outside workspace|workspace boundary|blocked|permission|unsafe url|restricted endpoint/i.test(detail)) {
    return {
      needsSteering: true,
      detectedIntent: "SAFETY",
      proposedAction: tool?.name || "tool action",
      recommendedAction: "choose a safe in-workspace action",
      guidance: "Keep the action within the workspace and use the tool that matches the requested operation.",
    };
  }
  return null;
}

export function patchReview(before, after, oldString = "", newString = "") {
  const beforeLines = String(before || "").split("\n");
  const afterLines = String(after || "").split("\n");
  const touched = Math.max(String(oldString).split("\n").length, String(newString).split("\n").length);
  const base = Math.max(beforeLines.length, afterLines.length, 1);
  return {
    touched,
    base,
    ratio: touched / base,
    targeted: String(before) !== String(after) && touched < base && (base < 20 || touched / base <= 0.7),
  };
}

export function toolMetadata(tool, result) {
  const text = String(result || "");
  const success = !resultFailed(text);
  const mutated = ["write", "edit", "apply_patch"].includes(tool.name) && success && !/^No changes to /i.test(text);
  return {
    success,
    mutated,
    filePath: mutated ? String(tool.args?.path || "") : "",
    validation: /syntax validation failed/i.test(text) ? "failed" : mutated ? "passed" : "not_applicable",
    exitCode: /^Exit:\s*(-?\d+)/m.exec(text)?.[1] ?? null,
  };
}

export function requestedSampleExtensions(contract) {
  return contract?.requestedExtensions || [];
}

export function needsFileMutation(contract) {
  return Boolean(contract?.modifiesFiles);
}

export function needsDeletionMutation(contract) {
  return contract?.intent === "delete";
}

export function clearWorkspaceRequest(contract) {
  return contract?.operation === "clear_workspace";
}

export function isDeletionCommand(command) {
  return destructiveCommand(command);
}

export function needsExecutionValidation(contract) {
  return Boolean(contract?.validationRequested || contract?.requiredEvidence?.includes("validation"));
}

export function isValidationCommand(command, domain = "general") {
  const normalized = String(command || "").trim();
  if (!normalized || /^(?:npm|pnpm|yarn|pip|pip3)\s+(?:i|install|add)\b/i.test(normalized)) return false;
  const executesCode = /\b(?:python(?:3)?|node|npm\s+test|pnpm\s+test|yarn\s+test|pytest|unittest|cargo\s+test|go\s+test)\b/i.test(normalized);
  if (!executesCode) return false;
  if (domain === "obfuscation") {
    const syntaxCheck = /ast\.parse|py_compile|node\s+--check/i.test(normalized);
    const chainedExecution = /(?:&&|;|\|\|)\s*(?:python(?:3)?|node|npm\s+test|pytest)\b/i.test(normalized);
    if (syntaxCheck && !chainedExecution) return false;
    return /(?:obfus|encrypt|\.obf\b|\.enc\b)/i.test(normalized);
  }
  return true;
}

export function expectedPlanTools(description) {
  const text = String(description).toLowerCase();
  if (/\b(?:github|git repository|repository|repo)\b/.test(text)) return ["repo", "bash", "websearch"];
  if (/\b(?:web\s*search|search (?:the )?web|search engine)\b/.test(text)) return ["websearch"];
  if (/\b(?:fetch|open|inspect).*(?:url|page|site|website)|\b(?:url|page|site|website).*(?:fetch|open|inspect)\b/.test(text)) return ["webfetch", "bash", "websearch"];
  if (/\b(?:create|write|implement|build|add)\b/.test(text)) return ["write", "edit", "apply_patch"];
  if (/\b(?:edit|modify|update|fix)\b/.test(text)) return ["edit", "write", "apply_patch"];
  if (/\b(?:run|test|validate)\b/.test(text)) return ["bash", "analyze"];
  if (/\b(?:list|find|scan)\b.*\bfiles?\b/.test(text)) return ["glob", "grep", "bash"];
  if (/\b(?:read|inspect)\b.*\bfiles?\b/.test(text)) return ["read", "glob", "grep", "analyze"];
  return null;
}

export function mutationSatisfiesPlanItem(tool, description) {
  if (!["write", "edit", "apply_patch"].includes(tool?.name)) return false;
  const source = String(tool.args?.content ?? tool.args?.newString ?? tool.args?.patchText ?? "").toLowerCase();
  if (!source) return false;
  const text = String(description).toLowerCase();
  const path = String(tool.args?.path || "").toLowerCase();
  const fileReferences = text.match(/[a-z0-9_.-]+\.(?:py|js|mjs|cjs|ts|tsx|json|md|html|css|sh)\b/g) || [];
  if (fileReferences.length && !fileReferences.some(file => path.endsWith(file))) return false;

  const evidence = [];
  if (/\bmarshal\b/.test(text)) evidence.push(/\bmarshal\b/.test(source));
  if (/\bargparse\b|command[- ]line|\bcli\b/.test(text)) evidence.push(/\bargparse\b|process\.argv|commander\b|yargs\b/.test(source));
  if (/syntax (?:check|validation)|validate syntax/.test(text)) evidence.push(/ast\.parse|compile\s*\(|py_compile|node\s+--check/.test(source));
  if (/error handling|handle errors?|exception handling/.test(text)) evidence.push(/\btry\s*:|\bexcept\b|\btry\s*\{|\bcatch\s*\(/.test(source));
  if (/\boop\b|object[- ]oriented|\bclass\b/.test(text)) evidence.push(/\bclass\s+[a-z_$]/i.test(source));
  if (/unit tests?|test cases?/.test(text)) evidence.push(/\bunittest\b|\bpytest\b|\bdef\s+test_|\b(?:assert|expect)\b/.test(source));

  return evidence.length > 0 && evidence.every(Boolean);
}

export function toolMatchesPlanItem(tool, description) {
  const expected = expectedPlanTools(description);
  if (expected && !expected.includes(tool.name)) return false;
  if (["write", "edit", "apply_patch"].includes(tool.name)) {
    const path = String(tool.args?.path || tool.args?.patchText || "").toLowerCase();
    const text = String(description).toLowerCase();
    const explicitExtension = /\.(py|js|mjs|cjs|ts|tsx|json|md|html|css)\b/.exec(text)?.[0];
    if (explicitExtension && !path.endsWith(explicitExtension)) return false;
    if (!explicitExtension && /\bpython\b/.test(text) && !path.endsWith(".py")) return false;
    if (!explicitExtension && /\bjavascript\b/.test(text) && !/\.(?:js|mjs|cjs)$/.test(path)) return false;
  }
  return true;
}

export function isInspectionCommand(command) {
  return inspectionCommand(command);
}

export function mutatesWorkspace(tool) {
  if (["write", "edit", "apply_patch", "task"].includes(tool.name)) return true;
  return tool.name === "bash" && !isInspectionCommand(tool.args?.command);
}

export function streamDisposition(prefix) {
  const text = String(prefix).trimStart();
  if (!text) return "pending";
  if (isProviderParseFailure(text)) return "structured";
  if (/<\s*\/?\s*(?:function|tool)_calls?/i.test(text)) return "structured";
  if (/<\s*invoke\b/i.test(text)) return "structured";
  if (/\{\s*["']tool["']\s*:/i.test(text)) return "structured";
  if (/\{\s*["'](?:read|write|edit|apply_patch|bash|glob|grep|analyze|web|webfetch|websearch|repo|question|task)["']\s*:/i.test(text)) {
    return "structured";
  }
  if (text.startsWith("{")) return "structured";
  if (/^(?:tool\s*:\s*)?(?:read|write|edit|apply_patch|bash|glob|grep|analyze|web|webfetch|websearch|repo|question|task)\s*\(/i.test(text)) {
    return "structured";
  }
  if (/^tool\s*:\s*(?:read|write|edit|apply_patch|bash|glob|grep|analyze|web|webfetch|websearch|repo|question|task)\b/i.test(text)) {
    return "structured";
  }
  if (text.startsWith("[")) {
    if (/^\[\s*[ .xX]\s*\]/.test(text)) return "structured";
    if (/^\[\s*\{/.test(text)) return "structured";
    return text.length < 5 ? "pending" : "text";
  }
  if (text.startsWith("```")) {
    const lineEnd = text.indexOf("\n");
    if (lineEnd < 0) return "pending";
    const language = text.slice(3, lineEnd).trim().toLowerCase();
    return !language || language === "json" || language === "javascript"
      ? "structured"
      : "text";
  }
  const functionPrefix = "<function_call";
  if (functionPrefix.startsWith(text.toLowerCase())) return "pending";
  if (text.toLowerCase().startsWith(functionPrefix)) return "structured";
  return "text";
}
