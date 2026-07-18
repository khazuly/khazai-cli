import { countTokens } from "../lib/tokens.js";
import { loadConfig } from "../config/index.js";
import { chat, resetSession, resolveModelDescriptor } from "../lib/llm.js";

import { execAsync } from "../lib/exec-async.js";
import { cleanInteractiveText } from "../lib/interactive-text.js";
import { ExecutionPolicy, destructiveCommand, inspectionCommand } from "./execution-policy.js";
import { fallbackIntentContract, normalizeIntentContract } from "./intent-resolver.js";
import { existsSync, readFileSync, statSync, writeFileSync, mkdtempSync, chmodSync, rmSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { redactSecrets, extractCredential } from "../lib/secrets.js";
import { createAssistantTextGuard, sanitizeAssistantIdentity } from "../lib/assistant-text.js";
import { InstructionService } from "./instruction.js";
import { getProviderPrompt } from "./prompts.js";
import { PermissionService } from "./permission.js";
import { getAgentProfile } from "./agent-profiles.js";
import { ToolLifecycle } from "./tool-lifecycle.js";
import { ToolExecutor } from "./tool-executor.js";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { SkillService } from "./skills.js";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function workspaceMetadata(workspace) {
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

const PARALLEL_READ_ONLY_TOOLS = new Set([
  "read", "glob", "grep", "analyze", "repo", "websearch", "webfetch", "lsp",
]);

const INSPECTION_TOOLS = new Set(["read", "glob", "grep", "analyze"]);
const IDEMPOTENT_MUTATION_TOOLS = new Set(["write", "edit", "apply_patch"]);
const MAX_LOOP_RECOVERIES = 4;

function sourceUrls(value) {
  return [...String(value || "").matchAll(/https?:\/\/[^\s<>"')\]]+/g)]
    .map(match => match[0].replace(/[.,;:]$/, ""))
    .filter((url, index, all) => all.indexOf(url) === index);
}

function deterministicIdentityAnswer(input) {
  const source = String(input || "").trim();
  if (/^(?:halo|hai|assalamu['’]?alaikum)[\s!,.?]*$/i.test(source)) {
    return "Hello! I'm KhazAI. How can I help?";
  }
  if (/\b(?:who are you|what(?:'s| is) your name|siapa kamu|siapa anda|nama kamu siapa|kamu siapa)\b/i.test(source)) {
    return "I'm KhazAI, a coding agent that can inspect, modify, and validate projects.";
  }
  return null;
}

function extractPlan(text) {
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

function normalizePlan(items) {
  const observable = items.filter(item => {
    const description = item.description.toLowerCase();
    const reasoningOnly = /\b(deduplicat|categor(?:y|ize)|summari[sz]e|compile (?:the )?(?:results|findings)|prepare (?:the )?(?:report|response)|present (?:the )?(?:results|findings)|report (?:the )?(?:results|findings))\b/i.test(description);
    const hasObservableAction = /\b(fetch|search|open|inspect|read|list|scan|analy[sz]e|create|write|edit|implement|fix|run|test|validate|install)\b/i.test(description);
    return !reasoningOnly || hasObservableAction;
  });
  return observable.length ? observable : items;
}

function requiresPlan(contract) {
  return Boolean(contract?.requiresPlan);
}

function fallbackPlan(contract) {
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

function extractInteractiveQuestion(text) {
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

function toolSignature(tool, workspace = "") {
  const args = { ...tool.args };
  delete args._agentWorkspace;
  if (args.path && !String(args.path).startsWith("/") && workspace) {
    args.path = resolve(workspace, String(args.path));
  }
  if (["glob", "grep"].includes(tool.name) && !args.path && workspace) args.path = workspace;
  if (tool.name === "bash" && typeof args.command === "string") {
    // Whitespace changes must not bypass the repeated-command guard.
    args.command = args.command.trim().replace(/\s+/g, " ");
  }
  return JSON.stringify({ tool: tool.name, args });
}

function publicToolArgs(args = {}) {
  return Object.fromEntries(
    Object.entries(args || {}).filter(([key]) => !key.startsWith("_")),
  );
}

function repeatedToolCycle(signatures, maximumPeriod = 4, repetitions = 3) {
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

function cachedToolAnswer(tool, result) {
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

function requestMode(contract) {
  if (contract?.category === "GIT_OPERATION" || contract?.operation === "git") return "neutral";
  if (["change", "delete"].includes(contract?.intent) || contract?.category === "MODIFICATION") return "mutate";
  if (["answer", "inspect", "research", "unknown"].includes(contract?.intent)) return "read-only";
  return "neutral";
}

function declaredSymbols(source) {
  const symbols = new Set();
  const text = String(source || "");
  for (const match of text.matchAll(/\b(?:class|def|function)\s+([A-Za-z_$][\w$]*)/g)) symbols.add(match[1]);
  return [...symbols];
}

function preservesImplementationStructure(existing, candidate) {
  const symbols = declaredSymbols(existing);
  if (symbols.length === 0) return true;
  const retained = symbols.filter(symbol => new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(candidate));
  return retained.length >= Math.ceil(symbols.length * 0.6);
}

function prospectiveFileContent(tool, existing) {
  if (tool.name === "write") return String(tool.args?.content || "");
  if (tool.name !== "edit") return null;
  const oldString = String(tool.args?.oldString ?? "");
  if (!oldString || !existing.includes(oldString)) return null;
  return existing.replace(oldString, String(tool.args?.newString ?? ""));
}

function shouldDeferToolCandidateProse(contract, hasPendingPlan) {
  return Boolean(hasPendingPlan || contract?.intent !== "answer" || contract?.targetUrl);
}

function wantsFileCount(contract) {
  return contract?.operation === "count_files";
}

function simpleFileListRequest(contract) {
  return contract?.operation === "list_files";
}

function fileCountFromToolResult(tool, result) {
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

function resultFailed(result) {
  const text = String(result || "");
  return text.startsWith("Error")
    || text.startsWith("Syntax validation")
    || /^Exit:\s*(?!0\b)-?\d+/m.test(text);
}

function isSteeringOutcome(value) {
  return isObject(value) && value.needsSteering === true;
}

function legacyGuardOutcome(value, tool, contract) {
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

function guardErrorOutcome(error, tool) {
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

function patchReview(before, after, oldString = "", newString = "") {
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

function toolMetadata(tool, result) {
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

function requestedSampleExtensions(contract) {
  return contract?.requestedExtensions || [];
}

function needsFileMutation(contract) {
  return Boolean(contract?.modifiesFiles);
}

function needsDeletionMutation(contract) {
  return contract?.intent === "delete";
}

function clearWorkspaceRequest(contract) {
  return contract?.operation === "clear_workspace";
}

function isDeletionCommand(command) {
  return destructiveCommand(command);
}

function needsExecutionValidation(contract) {
  return Boolean(contract?.validationRequested || contract?.requiredEvidence?.includes("validation"));
}

function isValidationCommand(command, domain = "general") {
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

function toolMatchesPlanItem(tool, description) {
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

function isInspectionCommand(command) {
  return inspectionCommand(command);
}

function mutatesWorkspace(tool) {
  if (["write", "edit", "apply_patch", "task"].includes(tool.name)) return true;
  return tool.name === "bash" && !isInspectionCommand(tool.args?.command);
}

export function streamDisposition(prefix) {
  const text = String(prefix).trimStart();
  if (!text) return "pending";
  // Provider/parser fallbacks are control-plane failures, never prose for the
  // user. Keep the buffer private until the recovery branch handles it.
  if (isProviderParseFailure(text)) return "structured";
  // Claude may prefix a native-style tool wrapper with prose. Re-check the
  // uncommitted tail on every chunk so structured payloads never reach the UI.
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

function isProviderParseFailure(text) {
  return /(?:i\s+(?:could not|couldn't|cannot)\s+parse\s+(?:the\s+)?response|failed\s+to\s+parse\s+(?:the\s+)?response|invalid\s+(?:tool\s+call|response\s+format)|response\s+(?:was\s+)?not\s+parseable)/i.test(String(text || ""));
}

function isShortContinuation(input) {
  return /^(?:yes|continue|go ahead|fix|ok|use this)$/i.test(String(input || "").trim());
}

function isNegativeContinuation(input) {
  return /^(?:no|cancel)$/i.test(String(input || "").trim());
}

function pendingActionState(contract, activeTask, {
  status = "active",
  offeredAction = "",
  reason = "",
  nextStep = "",
  evidence = [],
  gitPush = null,
} = {}) {
  return {
    version: 1,
    status,
    contract: normalizeIntentContract(contract, activeTask?.goal || contract?.request || ""),
    activeTask: { ...(activeTask || {}) },
    goal: String(activeTask?.goal || contract?.request || ""),
    targetFiles: [...new Set(activeTask?.targetFiles || [])],
    offeredAction: String(offeredAction || ""),
    reason: String(reason || ""),
    nextStep: String(nextStep || activeTask?.nextExpectedAction || ""),
    acceptanceCriteria: [...new Set(activeTask?.acceptanceCriteria || contract?.requiredEvidence || [])],
    evidence: Array.isArray(evidence) ? evidence.map(entry => ({ ...entry, args: { ...(entry.args || {}) } })) : [],
    // Commands are safe to retain; credentials are deliberately never stored.
    gitPush: gitPush?.command ? { command: String(gitPush.command) } : null,
  };
}

function offeredModificationContract(task, reply) {
  const goal = `${task?.goal || ""}\n${reply || ""}`;
  return normalizeIntentContract({
    ...task?.contract,
    intent: "change",
    category: "MODIFICATION",
    operation: "modify",
    requiredEvidence: ["mutation"],
    modifiesFiles: true,
  }, goal);
}

function offersFollowUpAction(reply) {
  return /(?:should|would you like|can i)\s+(?:i\s+)?(?:fix|patch|edit|continue)|(?:should i|would you like me to)\b/i.test(String(reply || ""));
}

function taskState(contract, goal) {
  const targets = [...new Set(String(goal || "").match(/(?:[\w.-]+\/)*[\w.-]+\.(?:js|mjs|cjs|ts|tsx|py|json|md|css|html|sh)\b/gi) || [])];
  return {
    activeIntent: contract.category || contract.intent,
    goal: String(goal || ""), targetFiles: targets, pendingProblem: "", lastToolResult: "",
    nextExpectedAction: "determine the next action from task evidence",
    acceptanceCriteria: contract.requiredEvidence || [], evidenceNeeded: contract.requiredEvidence || [],
  };
}

// Extract complete JSON values without being confused by braces inside quoted
// source code. Claude commonly wraps tool calls in <function_calls> and an
// array, while write/edit payloads can contain arbitrarily nested JSON-like
// syntax. A regular expression cannot parse those structures reliably.
export function extractJsonCandidates(text) {
  const source = String(text);
  const candidates = [];

  for (let start = 0; start < source.length; start++) {
    if (source[start] !== "{" && source[start] !== "[") continue;

    const stack = [];
    let inString = false;
    let escaped = false;
    let complete = false;

    for (let index = start; index < source.length; index++) {
      const character = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }

      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === "{" || character === "[") {
        stack.push(character);
        continue;
      }
      if (character !== "}" && character !== "]") continue;

      const opening = stack.pop();
      const matches = (opening === "{" && character === "}")
        || (opening === "[" && character === "]");
      if (!matches) break;
      if (stack.length === 0) {
        candidates.push(source.slice(start, index + 1));
        start = index;
        complete = true;
        break;
      }
    }

    // An incomplete outer wrapper may still contain a complete object later.
    // Advance by one character in that case so it can be considered.
    if (!complete) continue;
  }

  return candidates;
}

function decodeXmlEntities(value) {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function coerceTaggedArgument(value, schema = {}) {
  const decoded = decodeXmlEntities(value).trim();
  if (schema.type === "number") {
    const number = Number(decoded);
    return Number.isFinite(number) ? number : decoded;
  }
  if (schema.type === "boolean") return decoded.toLowerCase() === "true";
  if (schema.type === "array" || schema.type === "object") {
    try { return JSON.parse(decoded); } catch { return schema.type === "array" ? [decoded] : decoded; }
  }
  return decoded;
}

export function extractTaggedToolCall(text, registry) {
  const source = String(text);
  const names = registry.list().map(tool => tool.name);
  const isRegistered = name => names.includes(name);
  const invocations = [
    ...source.matchAll(/<invoke\b([^>]*)>([\s\S]*?)<\/invoke>/gi),
    ...source.matchAll(/<tool_call\b([^>]*)>([\s\S]*?)<\/tool_call>/gi),
  ];

  for (const invocation of invocations) {
    const attributes = invocation[1] || "";
    const body = invocation[2] || "";
    const name = /\b(?:name|tool)\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1]
      || /<(?:tool_name|name)>\s*([^<]+?)\s*<\/(?:tool_name|name)>/i.exec(body)?.[1]?.trim();
    if (!name || !isRegistered(name)) continue;

    const tool = registry.get(name);
    const properties = tool?.parameters?.properties || {};
    const args = {};
    const argumentsBlock = /<arguments?>\s*([\s\S]*?)\s*<\/arguments?>/i.exec(body)?.[1];
    if (argumentsBlock) {
      try {
        const parsed = JSON.parse(decodeXmlEntities(argumentsBlock));
        if (isObject(parsed)) return { name, args: parsed };
      } catch {}
    }
    const inlineJson = extractJsonCandidates(body).find(value => value.trimStart().startsWith("{"));
    if (inlineJson) {
      try {
        const parsed = JSON.parse(inlineJson);
        if (isObject(parsed)) return { name, args: parsed };
      } catch {}
    }

    for (const parameter of body.matchAll(/<parameter\b([^>]*)>([\s\S]*?)<\/parameter>/gi)) {
      const parameterName = /\bname\s*=\s*["']([^"']+)["']/i.exec(parameter[1] || "")?.[1];
      if (parameterName && Object.hasOwn(properties, parameterName)) {
        args[parameterName] = coerceTaggedArgument(parameter[2], properties[parameterName]);
      }
    }
    for (const [parameterName, schema] of Object.entries(properties)) {
      if (Object.hasOwn(args, parameterName)) continue;
      const escapedName = parameterName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = new RegExp(`<${escapedName}>\\s*([\\s\\S]*?)\\s*<\\/${escapedName}>`, "i").exec(body);
      if (match) args[parameterName] = coerceTaggedArgument(match[1], schema);
    }
    if (Object.keys(args).length > 0) return { name, args };
  }

  for (const name of names) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const call = new RegExp(`(?:^|\\n)\\s*(?:tool\\s*:\\s*)?${escapedName}\\s*\\(`, "i").exec(source);
    if (!call) continue;
    const tail = source.slice(call.index + call[0].length);
    const candidate = extractJsonCandidates(tail).find(value => value.trimStart().startsWith("{"));
    if (!candidate) continue;
    try {
      const args = JSON.parse(candidate);
      if (isObject(args)) return { name, args };
    } catch {}
  }

  const labeled = /(?:^|\n)\s*tool\s*:\s*([a-z][\w-]*)[^\n]*\n\s*(?:args?|arguments?|parameters?)\s*:\s*/i.exec(source);
  if (labeled && isRegistered(labeled[1])) {
    const tail = source.slice(labeled.index + labeled[0].length);
    const candidate = extractJsonCandidates(tail).find(value => value.trimStart().startsWith("{"));
    if (candidate) {
      try {
        const args = JSON.parse(candidate);
        if (isObject(args)) return { name: labeled[1], args };
      } catch {}
    }
  }
  return null;
}

// Legacy token-only providers need a quarantine window because their tool
// payloads arrive through the same callback as prose. Native typed streams do
// not pass through this buffer.
const LEGACY_PROTOCOL_HOLDBACK = 160;
const MAX_PROSE_CONTINUATIONS = 2;
// This deliberately does not try to repair JSON. A partial mutation is worse
// than no mutation: only a complete value may reach a tool executor.
function jsonCompletion(text) {
  const source = String(text || "");
  const stack = [];
  let inString = false;
  let escaped = false;
  for (const character of source) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; continue; }
    if (character === "{" || character === "[") { stack.push(character); continue; }
    if (character === "}" || character === "]") {
      const opening = stack.pop();
      if (!opening || (opening === "{" && character !== "}") || (opening === "[" && character !== "]")) {
        return "malformed";
      }
    }
  }
  return inString || stack.length ? "truncated" : "complete";
}

function validateToolArguments(tool, registry) {
  const registered = registry.get(tool?.name);
  if (!registered) return { kind: "unknown_tool", detail: "requested tool is not registered" };
  if (!isObject(tool.args)) return { kind: "schema_validation", detail: "args must be a JSON object" };
  const schema = registered.parameters || {};
  for (const key of schema.required || []) {
    if (!Object.hasOwn(tool.args, key) || tool.args[key] === undefined || tool.args[key] === null) {
      return { kind: "missing_required_argument", detail: `missing required argument \"${key}\"` };
    }
  }
  for (const [key, value] of Object.entries(tool.args)) {
    const definition = schema.properties?.[key];
    if (!definition) {
      if (schema.additionalProperties === false && !["_agentWorkspace", "_allowExternal"].includes(key)) {
        return { kind: "schema_validation", detail: `argument \"${key}\" is not allowed` };
      }
      continue; // Tools may accept runtime-only agent metadata.
    }
    const type = definition.type;
    const matches = !type
      || (type === "string" && typeof value === "string")
      || (type === "number" && typeof value === "number" && Number.isFinite(value))
      || (type === "boolean" && typeof value === "boolean")
      || (type === "array" && Array.isArray(value))
      || (type === "object" && isObject(value));
    if (!matches) return { kind: "schema_validation", detail: `argument \"${key}\" must be ${type}` };
    if (definition.enum && !definition.enum.includes(value)) {
      return { kind: "schema_validation", detail: `argument \"${key}\" is not an allowed value` };
    }
  }
  return null;
}

function delimiterCount(text, delimiter) {
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(delimiter, index)) !== -1) {
    let backslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) backslashes++;
    if (backslashes % 2 === 0) count++;
    index += delimiter.length;
  }
  return count;
}

export function proseLooksIncomplete(text) {
  const source = String(text || "").trimEnd();
  if (!source) return false;
  if (delimiterCount(source, "```") % 2 !== 0) return true;
  const withoutFences = source.replace(/```[\s\S]*?```/g, "");
  if (delimiterCount(withoutFences, "**") % 2 !== 0) return true;
  const withoutBold = withoutFences.replace(/\*\*[^\n]*?\*\*/g, "");
  if (delimiterCount(withoutBold, "`") % 2 !== 0) return true;
  return /(?:\[[^\]\n]*|\[[^\]\n]*\]\([^\)\n]*)$/.test(source);
}

function stripMarkdown(text) {
  return String(text || "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/^#+\s+/gm, "");
}

function joinProseContinuation(prefix, continuation) {
  const left = String(prefix || "");
  const right = String(continuation || "");
  if (!left) return right;
  if (!right) return left;

  // Some providers repeat the previous response despite being asked for a
  // continuation. Strip the repeated part locally before it reaches the UI.
  const repeatedAt = right.indexOf(left);
  if (repeatedAt !== -1) return left + right.slice(repeatedAt + left.length);
  const maximumOverlap = Math.min(left.length, right.length);
  for (let size = maximumOverlap; size > 0; size--) {
    if (left.slice(-size) === right.slice(0, size)) return left + right.slice(size);
  }
  return left + right;
}

export class Agent {
  constructor(registry, opts = {}) {
    this._workspace = opts.workspace || process.cwd();
    this._config = loadConfig(this._workspace);
    this._agentProfile = opts.agentProfile || getAgentProfile(
      this._workspace,
      opts.agent || this._config.defaultAgent || "build",
    );
    this._registry = registry.subset?.(this._agentProfile.tools || ["*"]) || registry;
    this._registryReady = typeof registry.load === "function"
      ? registry.load(this._workspace).then(() => {
          this._registry = registry.subset?.(this._agentProfile.tools || ["*"]) || registry;
        })
      : Promise.resolve();
    this._sessionId = String(opts.sessionId || randomUUID());
    this._model = opts.model || this._agentProfile.model || this._config.model;
    this._messages = [];
    this._summary = "";
    this._lastAnalysis = null;
    this._turn = 0;
    this._aborted = false;
    this._plan = null;
    this._planIndex = 0;
    this._lastToolIsRead = false;
    this._depsInstalled = false;
    this._readFiles = new Map();
    this._autoReadDone = new Set();
    this._consecutiveWrites = 0;
    this._consecutiveBash = 0;
    this._lastToolWasExecuted = false;
    this._totalWrites = 0;
    this._lastToolResult = null;
    this._toolCallHistory = [];
    this._completedToolResults = new Map();
    this._loopRecoveries = 0;
    this._loopRecoveryExhausted = false;
    this._questionHandler = opts.questionHandler || null;
    this._permissionHandler = opts.permissionHandler || null;
    this._permissionService = opts.permissionService || new PermissionService(this._workspace, this._config, {
      agentPermission: this._agentProfile.permission,
      auto: opts.autoApprove,
    });
    this._workspaceMetadata = workspaceMetadata(this._workspace);
    this._lifecycle = new ToolLifecycle({
      sessionId: this._sessionId,
      workspace: this._workspace,
      parts: opts.sessionState?.parts,
      onPart: opts.partHandler,
    });
    this._instructionService = new InstructionService(this._workspace);
    this._skillService = new SkillService(this._workspace);
    this._systemCache = null;
    this._currentRequest = "";
    this._inspectionCommands = new Set();
    this._requestMode = "neutral";
    this._readOnlyRedirects = 0;
    this._planningPhase = false;
    this._requiresPlan = false;
    this._planNarrations = 0;
    this._planMismatches = 0;
    this._postPlanToolRedirects = 0;
    this._requestStartIndex = 0;
    this._invalidToolResponses = 0;
    this._debug = Boolean(opts.debug || process.env.KHAZAI_DEBUG);
    this._latency = null;
    this._emptyResponses = 0;
    this._transportFailures = 0;
    this._toolEvidence = [];
    this._mutationSnapshots = new Map();
    this._patchReviews = new Map();
    this._inspectionCache = new Map();
    this._workspaceListing = null;
    this._cachedInspectionRedirects = 0;
    this._completionRedirects = 0;
    this._acceptedCreationOffer = null;
    this._resolvedArtifactDocumentation = false;
    this._researchSources = [];
    this._pendingGitPush = null;
    this._pendingBatchCalls = [];
    this._executionPolicy = null;
    this._taskContract = fallbackIntentContract("");
    this._activeTask = taskState(this._taskContract, "");
    this._pendingAction = null;
    this._chat = opts.chat || chat;
    this._resetSession = opts.resetSession || resetSession;
    const configuredResolver = opts.intentResolver;
    this._intentResolver = typeof configuredResolver === "function"
      ? { resolve: configuredResolver }
      : configuredResolver?.resolve
        ? configuredResolver
        : null;
    if (opts.sessionState) this.restoreSessionState(opts.sessionState);
  }

  abort() { this._aborted = true; this._abortController?.abort(); }
  setModel(model) { this._model = model; this._systemCache = null; }
  setQuestionHandler(handler) { this._questionHandler = handler; }
  setPermissionHandler(handler) { this._permissionHandler = handler; }
  setAutoApprove(value) { this._permissionService.setAuto(value); }
  compact() { this._compactMessages(); return this.exportSessionState(); }

  _markLatency(name) {
    if (!this._latency || this._latency[name] !== undefined) return;
    this._latency[name] = performance.now();
  }

  _finishLatency() {
    if (!this._latency) return;
    this._markLatency("completed");
    if (this._debug) {
      const start = this._latency.inputReceived;
      const metric = value => value === undefined ? null : Math.round((value - start) * 10) / 10;
      console.error(`[khazai debug] latency ${JSON.stringify({
        dispatchMs: metric(this._latency.requestDispatched),
        providerFirstDeltaMs: metric(this._latency.providerFirstDelta),
        uiFirstTextMs: metric(this._latency.uiFirstText),
        completedMs: metric(this._latency.completed),
      })}`);
    }
  }

  exportSessionState() {
    const state = {
      version: 4,
      sessionId: this._sessionId,
      messages: this._messages.slice(-200),
      summary: this._summary,
      model: this._model,
      agent: this._agentProfile?.name || "build",
      parts: this._lifecycle.parts.slice(-200),
    };
    // Session snapshots may be persisted by a UI host. Never let a token from
    // tool arguments, output, or a user message cross that boundary.
    return JSON.parse(redactSecrets(JSON.stringify(state)));
  }

  restoreSessionState(state) {
    if (!isObject(state)) return false;
    if (Array.isArray(state.messages)) {
      this._messages = state.messages
        .filter(message => !String(message?.content || "").startsWith("[INTERNAL STEERING]"))
        .slice(-200);
    }
    this._summary = typeof state.summary === "string" ? state.summary : "";
    if (state.model) this._model = String(state.model);
    if (state.sessionId) {
      this._sessionId = String(state.sessionId);
      this._lifecycle.sessionId = this._sessionId;
    }
    if (Array.isArray(state.parts)) this._lifecycle.parts = state.parts.slice(-200);
    this._pendingAction = null;
    this._pendingGitPush = null;
    this._currentRequest = "";
    return true;
  }

  _rememberPendingAction(details = {}) {
    this._pendingAction = pendingActionState(this._taskContract, this._activeTask, {
      evidence: this._toolEvidence,
      gitPush: this._pendingGitPush,
      ...details,
    });
  }

  _clearPendingAction() {
    this._pendingAction = null;
  }

  _pauseForRecovery({ detectedIntent, proposedAction, recommendedAction, guidance, reason = "" }) {
    const nextStep = recommendedAction || this._activeTask.nextExpectedAction || "continue the active task";
    this._activeTask.pendingProblem = redactSecrets(reason || this._activeTask.pendingProblem || "A recoverable agent step needs another attempt.");
    this._activeTask.nextExpectedAction = nextStep;
    this._rememberPendingAction({
      status: "recovering",
      reason: this._activeTask.pendingProblem,
      nextStep,
    });
    return this._steer({
      detectedIntent: detectedIntent || this._activeTask.activeIntent,
      proposedAction,
      recommendedAction: nextStep,
      guidance,
    });
  }

  _rememberInspection(tool, result) {
    if (resultFailed(result) || !INSPECTION_TOOLS.has(tool.name)) return;
    const signature = toolSignature(tool, this._workspace);
    this._inspectionCache.set(signature, String(result));
    if (tool.name === "glob") {
      const target = String(tool.args?.path || this._workspace);
      const absoluteTarget = target.startsWith("/") ? target : resolve(this._workspace, target);
      if (resolve(absoluteTarget) === resolve(this._workspace)) {
        this._workspaceListing = { result: String(result), signature };
      }
    }
  }

  _invalidateInspectionCache() {
    this._inspectionCache.clear();
    this._workspaceListing = null;
  }

  _rememberToolOutcome(tool, result) {
    if (resultFailed(result)) return;
    const signature = toolSignature(tool, this._workspace);
    if (IDEMPOTENT_MUTATION_TOOLS.has(tool.name)) {
      this._invalidateInspectionCache();
      this._completedToolResults.set(signature, String(result));
    } else if (INSPECTION_TOOLS.has(tool.name)) {
      this._rememberInspection(tool, result);
    }
    this._loopRecoveries = 0;
  }

  _toolLoopRecovery(tool) {
    // OpenCode leaves tool selection to the model. The overall max-turn and
    // cancellation limits remain the non-interactive circuit breakers.
    return null;
  }

  _filterRepeatedBatchTools(tools) {
    const executable = [];
    for (const tool of tools) {
      const recovery = this._toolLoopRecovery(tool);
      if (!recovery) {
        executable.push(tool);
        continue;
      }
      if (recovery.exhausted) {
        this._loopRecoveryExhausted = true;
        break;
      }
    }
    return executable;
  }

  _boundedLoopRecoveryAnswer() {
    const answer = "I couldn't make further progress because the available actions kept repeating without changing the task result. Please provide the exact target or expected outcome.";
    this._messages.push({ role: "assistant", content: answer });
    this._clearPendingAction();
    this._finishLatency();
    return answer;
  }

  _cleanAnswer(text) {
    let clean = sanitizeAssistantIdentity(redactSecrets(text))
      .replace(/^final answer\s*:?\s*/im, "")
      .replace(/```\w*\n[\s\S]*?```/g, (m) => {
        const code = m.replace(/```\w*\n?/g, "").trim();
        return code;
      });
    clean = stripMarkdown(clean);
    clean = clean.replace(/\n{3,}/g, "\n\n").trim();
    return clean;
  }

  _missingCompletionEvidence() {
    return null;
  }

  _completionSteering(missingEvidence) {
    const policySteering = this._executionPolicy?.completionSteering?.();
    if (policySteering) return policySteering;

    const category = this._activeTask.activeIntent || this._taskContract.category;
    const byCategory = {
      GIT_OPERATION: {
        recommendedAction: "resume the pending Git command or resolve remote, branch, upstream, or authentication",
        guidance: "Continue the pending Git operation from its last result. Ask cleanly for credentials only when authentication is required.",
      },
      MODIFICATION: {
        recommendedAction: "inspect the target and apply the smallest targeted edit or patch",
        guidance: "Continue the requested code change. Preserve unrelated code and run requested validation after the patch.",
      },
      TESTING: {
        recommendedAction: "run the relevant test or validation and recover from its result",
        guidance: "Continue the active testing task with the relevant command, then address any observed failure.",
      },
      INSPECTION: {
        recommendedAction: "perform the relevant read or search",
        guidance: "Continue the inspection until there is enough relevant information to answer the user.",
      },
      RESEARCH: {
        recommendedAction: "retry the relevant fetch or use a safe fallback",
        guidance: "Continue the active web analysis from the last fetch result instead of ending the task early.",
      },
    };
    return {
      detectedIntent: category || "UNKNOWN",
      proposedAction: "final response before the active task has finished",
      ...(byCategory[category] || {
        recommendedAction: this._activeTask.nextExpectedAction || "take the next active task action",
        guidance: "Continue from the active task state and last tool result before responding finally.",
      }),
    };
  }

  _evidenceAnswer(fallback) {
    return this._cleanAnswer(fallback);
  }

  _buildSystem() {
    const revision = this._instructionService.revision();
    const hasSkillTool = Boolean(this._registry.get("skill"));
    const skillRevision = hasSkillTool ? this._skillService.revision() : "";
    let descriptor;
    try {
      descriptor = resolveModelDescriptor(this._model, this._config);
    } catch {
      descriptor = { exactID: this._model };
    }
    const date = new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
    const cacheKey = JSON.stringify({
      model: this._model,
      exactModel: descriptor.exactID,
      agent: this._agentProfile?.name,
      profileInstructions: this._agentProfile?.instructions || "",
      analysis: this._lastAnalysis || "",
      revision,
      skillRevision,
      date,
    });
    if (this._systemCache?.key === cacheKey) return this._systemCache.value;
    this._instructionService.clearCache();
    const instructionBlock = this._instructionService.getSystemPromptBlock();
    const skills = hasSkillTool
      ? this._skillService.list().filter(skill => (
        this._permissionService.evaluate("skill", { name: skill.name }).decision !== "deny"
      ))
      : [];

    const envInfo = [
      `You are powered by the model ${descriptor.exactID}.`,
      `Here is some useful information about the environment you are running in:`,
      `<env>`,
      `  Working directory: ${this._workspaceMetadata.workingDirectory}`,
      `  Worktree: ${this._workspaceMetadata.worktree}`,
      `  Is directory a git repo: ${this._workspaceMetadata.isGitRepo ? "yes" : "no"}`,
      `  Platform: ${process.platform}`,
      `  Today's date: ${date}`,
      `</env>`,
      "",
    ].join("\n");

    const parts = [
      getProviderPrompt(this._model, this._workspace, instructionBlock),
      envInfo,
    ];
    if (this._agentProfile?.instructions) {
      parts.push("ACTIVE AGENT PROFILE:", this._agentProfile.instructions, "");
    }
    if (skills.length) {
      parts.push(
        "AVAILABLE SKILLS:",
        "Use the skill tool to load a skill's full instructions when its description matches the task.",
        ...skills.map(skill => `- ${skill.name}: ${skill.description}`),
        "",
      );
    }

    if (this._lastAnalysis) {
      parts.push("LATEST ANALYSIS:", this._lastAnalysis, "");
    }
    const value = parts.join("\n");
    this._systemCache = { key: cacheKey, value };
    return value;
  }

  _parseToolJson(parsed) {
    if (typeof parsed === "string") {
      try { return this._parseToolJson(JSON.parse(parsed)); } catch { return null; }
    }
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        const tool = this._parseToolJson(entry);
        if (tool) return tool;
      }
      return null;
    }
    if (typeof parsed?.tool === "string" && parsed.tool.trim() && isObject(parsed.args)) {
      const tool = { name: parsed.tool, args: parsed.args };
      const id = parsed.id || parsed.tool_call_id;
      if (id) tool.id = id;
      return tool;
    }
    if (typeof parsed?.tool === "string" && parsed.tool.trim() && isObject(parsed.arguments)) {
      return { name: parsed.tool, args: parsed.arguments };
    }
    if (typeof parsed?.tool === "string" && parsed.tool.trim()) {
      // Claude sometimes flattens arguments into the tool object, for example
      // {"tool":"read","path":"file.js"}. Normalize only parameters
      // declared by the registered tool so envelope metadata cannot leak into
      // execution arguments.
      const registered = this._registry.get(parsed.tool);
      const properties = registered?.parameters?.properties || {};
      const args = Object.fromEntries(
        Object.keys(properties)
          .filter(key => Object.hasOwn(parsed, key))
          .map(key => [key, parsed[key]]),
      );
      if (registered && Object.keys(args).length > 0) {
        return { name: parsed.tool, args };
      }
    }
    if (typeof parsed?.name === "string" && parsed.name.trim()) {
      let args = parsed.arguments ?? parsed.input ?? parsed.parameters;
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { args = null; }
      }
      if (isObject(args)) return { name: parsed.name, args };
    }
    if (isObject(parsed?.function)) {
      return this._parseToolJson(parsed.function);
    }
    for (const container of [parsed?.tool_calls, parsed?.function_calls, parsed?.content]) {
      if (Array.isArray(container)) {
        const tool = this._parseToolJson(container);
        if (tool) return tool;
      }
    }
    const keys = Object.keys(parsed || {});
    if (keys.length === 1 && isObject(parsed[keys[0]]) && this._registry.get(keys[0])) {
      return { name: keys[0], args: parsed[keys[0]] };
    }
    return null;
  }

  _extractNativeTool(text) {
    try {
      const parsed = JSON.parse(String(text || "").trim());
      if (Array.isArray(parsed)) {
        const tools = parsed.slice(0, 8).map(entry => this._parseToolJson(entry)).filter(Boolean);
        return tools.length ? { tool: tools[0], tools, error: null, kind: null } : { tool: null, error: null, kind: null };
      }
      const tool = this._parseToolJson(parsed);
      return { tool, error: null, kind: null };
    } catch {
      return { tool: null, error: "Native tool call payload was malformed.", kind: "malformed_json", truncated: false };
    }
  }

  _extractTool(text) {
    const reply = text.trim();
    const toolNames = this._registry.list().map(t => t.name).join("|");

    if (isProviderParseFailure(reply)) {
      return { tool: null, error: "provider response could not be parsed", truncated: false, kind: "provider_parse_failure" };
    }

    try {
      const parsed = JSON.parse(reply);
      if (Array.isArray(parsed)) {
        const tools = parsed.slice(0, 8).map(entry => this._parseToolJson(entry)).filter(Boolean);
        if (tools.length) return { tool: tools[0], tools, error: null, kind: null };
      }
      const tool = this._parseToolJson(parsed);
      if (tool) return { tool, error: null, kind: null };
    } catch {}

    for (const candidate of extractJsonCandidates(reply)) {
      try {
        const parsed = JSON.parse(candidate);
        const tool = this._parseToolJson(parsed);
        if (tool) return { tool, error: null, kind: null };
      } catch { continue; }
    }

    const taggedTool = extractTaggedToolCall(reply, this._registry);
    if (taggedTool) return { tool: taggedTool, error: null, kind: null };

    const toolLike = /<\s*\/?\s*(?:function|tool)_calls?/i.test(reply)
      || /<\s*(?:invoke|tool_call)\b/i.test(reply)
      || /["']tool["']\s*:/i.test(reply)
      || /["'](?:tool_calls|function_calls|tool_use)["']\s*:/i.test(reply)
      || new RegExp(`["'](?:${toolNames})["']\\s*:`).test(reply);
    if (toolLike) {
      const completion = jsonCompletion(reply);
      const truncated = completion === "truncated";
      return {
        tool: null,
        error: truncated
          ? "The tool call was truncated before its JSON payload completed."
          : "Found tool-like text but could not parse a valid JSON tool call.",
        truncated,
        kind: truncated ? "truncated_json" : "malformed_json",
      };
    }

    return { tool: null, error: null, kind: null };
  }

  _debugToolRecovery(kind, detail) {
    if (this._debug) console.error(`[khazai debug] tool recovery (${kind}): ${detail}`);
  }

  _steer({ detectedIntent, proposedAction, recommendedAction, guidance }) {
    const event = {
      type: "steering",
      needsSteering: true,
      detectedIntent: detectedIntent || this._taskContract?.category || "UNKNOWN",
      proposedAction: proposedAction || "tool action",
      recommendedAction: recommendedAction || "continue safely",
      guidance: redactSecrets(guidance || "Continue from the current task state with a safe next action."),
    };
    if (this._debug) console.error(`[khazai debug] steering ${JSON.stringify(event)}`);
    // This is model context, never an assistant-visible tool result.
    this._messages.push({
      role: "user",
      content: `[INTERNAL STEERING]\nDetected intent: ${event.detectedIntent}\nProposed action: ${event.proposedAction}\nRecommended action: ${event.recommendedAction}\nGuidance: ${event.guidance}`,
    });
    return event;
  }

  _toolRecoveryInstruction(kind, attempt, detail = "") {
    const common = "Continue the current task from the existing plan, tool results, and unfinished action; do not restart. Return exactly one complete JSON tool call, with no markdown or surrounding text.";
    const compact = "Use one operation only. Do not combine actions. Keep arguments small; for a large edit, first inspect or make one smaller edit per step.";
    const guidance = {
      truncated_json: `Your previous tool JSON was cut off. ${compact} If content is large, split it into several valid write/edit operations. Ensure every quote, brace, and array is closed.`,
      malformed_json: `Your previous tool JSON was malformed. ${compact} Follow the tool schema exactly and emit valid JSON only.`,
      unknown_tool: "The requested tool does not exist. Choose one tool from the supplied tool schema and preserve the current unfinished action.",
      missing_required_argument: `The call omitted ${detail || "a required argument"}. Include every required argument from the selected tool schema. ${compact}`,
      schema_validation: `The call does not match the selected tool schema (${detail || "invalid arguments"}). Correct argument names and types. ${compact}`,
      provider_parse_failure: `The previous provider response was not usable. ${compact} Reissue the next expected action using the current task state and tool schema.`,
    };
    const escalation = attempt > 1
      ? " The previous correction did not produce an executable call. Change strategy now: inspect the exact target first when context is missing; for an existing file, use one edit patch with exact oldString/newString; for a new file, use one small write; for shell work, run one command only."
      : "";
    return `Internal tool-call recovery: ${guidance[kind] || guidance.malformed_json}${escalation}\n${common}`;
  }

  _normalizeTool(tool) {
    return tool;
  }

  _prepareToolArgs(name, input) {
    const args = { ...(input || {}) };
    if (name === "bash") {
      args.workdir = args.workdir
        ? resolve(this._workspace, String(args.workdir))
        : this._workspace;
    }
    if (["read", "write", "edit", "analyze", "glob", "grep"].includes(name)
      && args.path && !String(args.path).startsWith("/")) {
      args.path = resolve(this._workspace, String(args.path));
    }
    if (["read", "write", "edit", "apply_patch", "analyze", "glob", "grep", "task"].includes(name)) {
      args._agentWorkspace = this._workspace;
    }
    return args;
  }

  _toolExecutor() {
    return new ToolExecutor({
      registry: this._registry,
      lifecycle: this._lifecycle,
      permissionService: this._permissionService,
      permissionHandler: request => this._permissionHandler?.(request),
      questionHandler: question => this._questionHandler?.(question),
      workspace: this._workspace,
      worktree: this._workspaceMetadata.worktree,
      sessionId: this._sessionId,
      normalizeCall: call => this._normalizeTool(call),
      prepareArgs: (name, args) => this._prepareToolArgs(name, args),
      resultFailed,
      timeoutMs: this._config.toolTimeout,
      signal: this._abortController?.signal,
    });
  }

  async *_runReadOnlyBatch(tools) {
    const candidates = tools.slice(0, 8).map(tool => this._normalizeTool(tool));
    const normalized = this._filterRepeatedBatchTools(candidates);
    if (this._loopRecoveryExhausted || normalized.length === 0) {
      this._lifecycle.finishStep("tool-calls");
      return true;
    }
    if (!normalized.every(tool => PARALLEL_READ_ONLY_TOOLS.has(tool.name))) return false;
    const settled = [];
    const concurrency = Math.min(8, Math.max(1, Number(this._config.toolConcurrency) || 4));
    for await (const event of this._toolExecutor().executeBatch(
      normalized,
      { agent: this._agentProfile?.name },
      concurrency,
    )) {
      if (event.type === "execution-result") {
        settled.push({ tool: event.call, part: event.part, result: event.result, failed: event.failed });
      } else {
        yield event;
      }
    }
    this._messages.push({
      role: "assistant",
      content: null,
      tool_calls: settled.map(entry => ({
        id: entry.tool.id,
        type: "function",
        function: {
          name: entry.tool.name,
          arguments: JSON.stringify(publicToolArgs(entry.tool.args)),
        },
      })),
    });
    for (const entry of settled) {
      const result = redactSecrets(String(entry.result));
      const metadata = toolMetadata(entry.tool, result);
      const failed = entry.failed || resultFailed(result);
      this._rememberToolOutcome(entry.tool, result);
      this._toolEvidence.push({ tool: entry.tool.name, args: { ...entry.tool.args }, result, failed, metadata });
      this._messages.push({
        role: "tool",
        tool_call_id: entry.tool.id,
        name: entry.tool.name,
        content: result,
      });
      if (["websearch", "webfetch", "repo"].includes(entry.tool.name)) {
        this._researchSources = [...new Set([...this._researchSources, ...sourceUrls(result)])].slice(0, 20);
      }
      this._lastToolResult = result;
      this._activeTask.lastToolResult = result.slice(0, 1500);
    }
    for (const part of this._lifecycle.finishStep(this._stepBlocked ? "denied" : "tool-calls")) {
      yield { type: "tool-part", part };
    }
    this._lastToolWasExecuted = settled.length > 0;
    if (this._plan && this._planIndex < this._plan.length && settled.some(entry => !resultFailed(entry.result))) {
      this._plan[this._planIndex].status = "done";
      yield { type: "plan-update", index: this._planIndex, status: "done" };
      this._planIndex++;
    }
    return true;
  }

  async *_runSequentialBatch(tools) {
    const candidates = tools.slice(0, 8).map(tool => this._normalizeTool(tool));
    const calls = this._filterRepeatedBatchTools(candidates);
    if (this._loopRecoveryExhausted || calls.length === 0) {
      this._lifecycle.finishStep("tool-calls");
      return true;
    }
    this._messages.push({
      role: "assistant",
      content: null,
      tool_calls: calls.map(call => ({
        id: call.id || (call.id = randomUUID()),
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(publicToolArgs(call.args)),
        },
      })),
    });
    let failed = false;
    for (const call of calls) {
      for await (const event of this._toolExecutor().execute(call, { agent: this._agentProfile?.name })) {
        if (event.type !== "execution-result") {
          yield event;
          continue;
        }
        const result = redactSecrets(String(event.result));
        failed ||= event.failed;
        const metadata = toolMetadata(event.call, result);
        this._rememberToolOutcome(event.call, result);
        this._toolEvidence.push({
          tool: event.call.name,
          args: { ...event.call.args },
          result,
          failed: event.failed,
          metadata,
        });
        this._messages.push({
          role: "tool",
          tool_call_id: event.call.id,
          name: event.call.name,
          content: result,
        });
        this._lastToolResult = result;
        this._activeTask.lastToolResult = result.slice(0, 1500);
      }
    }
    for (const part of this._lifecycle.finishStep(failed ? "tool-error" : "tool-calls")) {
      yield { type: "tool-part", part };
    }
    this._lastToolWasExecuted = calls.length > 0;
    return true;
  }

  _compactMessages() {
    const usage = this._messages.reduce((total, message) => (
      total
      + countTokens(String(message.content || ""))
      + countTokens(JSON.stringify(message.tool_calls || []))
    ), 0);
    if (usage < this._config.tokenBudget * this._config.compactThreshold) return;

    const target = this._config.tokenBudget * 0.45;
    let keptTokens = 0;
    let keepFrom = this._messages.length;
    for (let index = this._messages.length - 1; index >= 0; index--) {
      const message = this._messages[index];
      const size = countTokens(String(message.content || ""))
        + countTokens(JSON.stringify(message.tool_calls || []));
      if (keptTokens > 0 && keptTokens + size > target) break;
      keptTokens += size;
      keepFrom = index;
    }
    while (keepFrom > 0 && this._messages[keepFrom]?.role === "tool") keepFrom--;

    const earlier = this._messages.slice(0, keepFrom);
    const transcript = earlier
      .filter(message => ["user", "assistant"].includes(message.role) && message.content)
      .map(message => `${message.role === "user" ? "User" : "Assistant"}: ${String(message.content)}`)
      .join("\n")
      .slice(-6000);
    if (transcript) {
      this._summary = [this._summary, transcript].filter(Boolean).join("\n").slice(-8000);
    }
    this._messages = this._messages.slice(keepFrom);
  }

  async _getRemoteUrl() {
    try {
      const result = await execAsync("git remote get-url origin", {
        cwd: this._workspace,
        timeoutMs: 10_000,
      });
      return (result.stdout || "").trim() || null;
    } catch {
      return null;
    }
  }

  async _runBash(command, workdir) {
    try {
      const result = await execAsync(command, {
        cwd: workdir || this._workspace,
        timeoutMs: 30_000,
      });
      return `Exit: 0\n${redactSecrets(result.stdout || result.stderr || "")}`;
    } catch (error) {
      return `Exit: 1\n${redactSecrets([error?.stdout, error?.stderr, error?.message].filter(Boolean).join("\n"))}`;
    }
  }

  async _pushWithTemporaryCredential(command, token) {
    const directory = mkdtempSync(join(tmpdir(), "khazai-git-askpass-"));
    const askpass = join(directory, "askpass.sh");
    try {
      writeFileSync(askpass, "#!/bin/sh\nprintf '%s' \"$KHAZAI_GIT_TOKEN\"\n", { mode: 0o700 });
      chmodSync(askpass, 0o700);
      const result = await execAsync(command, {
        cwd: this._workspace,
        timeoutMs: 60_000,
        env: { GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: "0", KHAZAI_GIT_TOKEN: token },
      });
      return { ok: true, result: `Exit: 0\n${redactSecrets(result.stdout || result.stderr || "Push completed.")}` };
    } catch (error) {
      const detail = redactSecrets([error?.stdout, error?.stderr, error?.message].filter(Boolean).join("\n"));
      const auth = /auth|credential|password|token|permission denied|401|403/i.test(detail);
      return { ok: false, result: auth ? "Push failed because authentication was rejected." : "Push failed. Check the remote, branch, and connection, then try again." };
    } finally {
      try { rmSync(directory, { recursive: true, force: true }); } catch {}
    }
  }

  async *_runShellShortcut(input) {
    const command = String(input || "").slice(1).trim();
    if (!command) {
      const answer = "Enter a command after !.";
      this._messages.push({ role: "user", content: input });
      this._messages.push({ role: "assistant", content: answer });
      yield { type: "stream", token: answer };
      yield { type: "stream-end" };
      return;
    }

    this._taskContract = normalizeIntentContract({
      intent: "change",
      category: "SHELL_OPERATION",
      operation: "shell",
      requiredEvidence: ["shell"],
      modifiesFiles: false,
    }, input);
    this._activeTask = taskState(this._taskContract, input);
    this._currentRequest = input;
    this._messages.push({ role: "user", content: input });
    this._requestStartIndex = this._messages.length - 1;
    this._toolEvidence = [];
    this._toolCallHistory = [];
    this._completedToolResults.clear();
    this._invalidateInspectionCache();

    const snapshot = this._lifecycle.startStep();
    if (snapshot) yield { type: "tool-part", part: snapshot };
    const call = {
      id: randomUUID(),
      name: "bash",
      args: { command, workdir: this._workspace },
    };
    this._messages.push({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(publicToolArgs(call.args)),
        },
      }],
    });
    let result = "";
    let failed = false;
    let finishReason = "tool-calls";
    for await (const event of this._toolExecutor().execute(call, { agent: this._agentProfile?.name })) {
      if (event.type === "execution-result") {
        result = redactSecrets(String(event.result || ""));
        failed = Boolean(event.failed);
        finishReason = event.finishReason;
      } else {
        yield event;
      }
    }
    this._messages.push({
      role: "tool",
      tool_call_id: call.id,
      name: call.name,
      content: result.slice(0, 6000),
    });
    this._toolEvidence.push({ tool: "bash", args: call.args, result, failed, metadata: toolMetadata(call, result) });
    this._lastToolResult = result;
    this._activeTask.lastToolResult = result.slice(0, 1500);
    for (const lifecyclePart of this._lifecycle.finishStep(finishReason)) {
      yield { type: "tool-part", part: lifecyclePart };
    }
    const exitCode = /^Exit:\s*(-?\d+)/im.exec(result)?.[1];
    const answer = failed
      ? `Command finished with exit code ${exitCode ?? "unknown"}.`
      : `Command finished with exit code ${exitCode ?? "0"}.`;
    this._messages.push({ role: "assistant", content: answer });
    this._finishLatency();
    yield { type: "stream", token: answer };
    yield { type: "stream-end" };
  }

  _buildContext() {
    const sys = this._buildSystem();
    const summary = this._summary
      ? [{ role: "assistant", content: `Earlier conversation summary:\n${this._summary}` }]
      : [];
    let used = countTokens(sys) + countTokens(summary[0]?.content || "");
    const selected = [];
    for (let index = this._messages.length - 1; index >= 0; index--) {
      const message = this._messages[index];
      if (String(message.content || "").startsWith("[INTERNAL STEERING]")) continue;
      const size = countTokens(String(message.content || ""))
        + countTokens(JSON.stringify(message.tool_calls || []));
      if (selected.length > 0 && used + size > this._config.tokenBudget) break;
      selected.unshift(message);
      used += size;
    }
    return [{ role: "system", content: sys }, ...summary, ...selected];
  }

  async *loop(input, signal) {
    await this._registryReady;
    this._abortController = new AbortController();
    if (signal?.aborted) this._abortController.abort();
    else signal?.addEventListener("abort", () => this._abortController.abort(), { once: true });
    this._latency = { inputReceived: performance.now() };
    const pendingGit = null;

    // Clean up token from previous push if present
    if (this._savedRemoteUrl) {
      await this._runBash(`git remote set-url origin ${this._savedRemoteUrl}`, this._workspace);
      this._savedRemoteUrl = null;
      this._savedToken = null;
    }

    const suppliedCredential = pendingGit ? extractCredential(input) : null;
    if (false && suppliedCredential) {
      const pending = pendingGit;
      const safeInput = redactSecrets(input);
      this._taskContract = normalizeIntentContract({
        intent: "change", category: "GIT_OPERATION", operation: "git",
        requiredEvidence: ["git"], modifiesFiles: false,
      }, safeInput);
      this._requestMode = "neutral";
      this._executionPolicy = new ExecutionPolicy(this._taskContract);
      this._currentRequest = "Continue the pending Git push with a temporarily supplied credential [REDACTED].";
      this._messages.push({ role: "user", content: safeInput });
      this._requestStartIndex = this._messages.length - 1;
      const args = { command: pending.command, workdir: this._workspace };
      const snapshotPart = this._lifecycle.startStep();
      if (snapshotPart) yield { type: "tool-part", part: snapshotPart };
      const callId = randomUUID();
      const part = this._lifecycle.pending({ callId, tool: "bash", input: args });
      yield { type: "tool-part", part: { ...part, state: { ...part.state } } };
      this._lifecycle.running(part, args);
      yield { type: "tool-part", part: { ...part } };
      yield { type: "tool-call", tool: "bash", args, callId };
      const pushed = await this._pushWithTemporaryCredential(pending.command, suppliedCredential);
      if (pushed.ok) this._lifecycle.completed(part, pushed.result);
      else this._lifecycle.failed(part, pushed.result);
      yield { type: "tool-part", part: { ...part } };
      yield { type: "tool-result", tool: "bash", result: pushed.result, callId, failed: !pushed.ok };
      for (const lifecyclePart of this._lifecycle.finishStep(pushed.ok ? "tool-calls" : "tool-error")) {
        yield { type: "tool-part", part: lifecyclePart };
      }
      this._toolEvidence = [{ tool: "bash", args, result: pushed.result, failed: !pushed.ok }];
      this._executionPolicy.record("bash", args, pushed.result, !pushed.ok);
      this._pendingGitPush = pushed.ok ? null : pending;
      if (pushed.ok) this._clearPendingAction();
      else this._rememberPendingAction({
        status: "awaiting_credential",
        reason: "Git push needs valid authentication.",
        nextStep: "provide a valid credential for the pending Git push",
        gitPush: pending,
      });
      const answer = pushed.ok ? "Push succeeded." : pushed.result;
      this._messages.push({ role: "assistant", content: answer });
      yield { type: "answer", content: answer };
      return;
    }
    // Extract token from user input when it contains a git push request + credential.
    // Set up the remote URL with the token, then let the LLM handle the full
    // git workflow naturally (status, diff, log, then push).
    // The token is cleaned up after the LLM loop completes.
    const hasToken = extractCredential(input);
    const isGitPushRequest = /\bgit\s+push\b/i.test(input);
    if (false && hasToken && isGitPushRequest && !pendingGit) {
      const remoteUrl = await this._getRemoteUrl();
      if (remoteUrl && !this._savedRemoteUrl) {
        this._savedRemoteUrl = remoteUrl;
        this._savedToken = hasToken;
        const tokenUrl = remoteUrl.includes("@")
          ? remoteUrl.replace(/https:\/\/[^@]*@/, `https://${hasToken}@`)
          : remoteUrl.replace("https://", `https://${hasToken}@`);
        const setupResult = await this._runBash(`git remote set-url origin ${tokenUrl}`, this._workspace);
        const safeInputForLlm = input.replace(new RegExp(hasToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "[TOKEN]");
        yield { type: "tool-call", tool: "bash", args: { command: "git remote set-url origin https://[TOKEN]@.../" } };
        yield { type: "tool-result", tool: "bash", result: setupResult };
        input = safeInputForLlm;
      }
    }
    this._compactMessages();
    const safeInput = redactSecrets(input);
    if (safeInput.trimStart().startsWith("!")) {
      yield* this._runShellShortcut(safeInput.trimStart());
      return;
    }
    this._messages.push({ role: "user", content: safeInput });
    this._requestStartIndex = this._messages.length - 1;
    this._currentRequest = safeInput;
    this._pendingAction = null;
    this._pendingGitPush = null;
    this._requestMode = "neutral";
    this._requiresPlan = false;
    this._planningPhase = false;
    this._turn = 0;
    this._aborted = false;
    this._lastToolWasExecuted = false;
    this._totalWrites = 0;
    this._plan = null;
    this._planIndex = 0;
    this._lastToolResult = null;
    this._toolCallHistory = [];
    this._completedToolResults.clear();
    this._loopRecoveries = 0;
    this._loopRecoveryExhausted = false;
    this._invalidateInspectionCache();
    this._inspectionCommands.clear();
    this._readOnlyRedirects = 0;
    this._planNarrations = 0;
    this._planMismatches = 0;
    this._postPlanToolRedirects = 0;
    this._invalidToolResponses = 0;
    this._emptyResponses = 0;
    this._transportFailures = 0;
    this._toolEvidence = [];
    this._mutationSnapshots.clear();
    this._patchReviews.clear();
    this._cachedInspectionRedirects = 0;
    this._completionRedirects = 0;
    this._resolvedArtifactDocumentation = false;
    this._researchSources = [];
    this._executionPolicy = null;
    let pendingProse = "";
    let proseContinuations = 0;

    // Clearing a workspace is unambiguous when the user explicitly asks to
    // remove every file. Execute it locally instead of trusting a model to call
    // a destructive tool or accepting an unsupported "done" claim. `find`
    // handles hidden entries as well, and the final `test` verifies the exact
    // workspace root is empty before completion is reported.
    if (false && clearWorkspaceRequest(this._taskContract)) {
      const bash = this._registry.get("bash");
      if (!bash) {
        yield this._steer({
          detectedIntent: "DESTRUCTIVE_OPERATION",
          proposedAction: "clear workspace without shell tool",
          recommendedAction: "use the available destructive-operation tool",
          guidance: "Keep the requested workspace-clear task active and choose an available safe tool action. Do not report completion.",
        });
      } else {
        const args = {
          command: "find . -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && test -z \"$(find . -mindepth 1 -maxdepth 1 -print -quit)\"",
          workdir: this._workspace,
        };
        yield { type: "tool-call", tool: "bash", args };
        let result;
        try {
          result = await bash.execute(args);
        } catch (error) {
          result = `Error: ${error.message}`;
        }
        yield { type: "tool-result", tool: "bash", result };
        const failed = resultFailed(result);
        this._toolEvidence.push({ tool: "bash", args: { ...args }, result, failed });
        this._executionPolicy.record("bash", args, result, failed);
        if (failed) {
          this._activeTask.pendingProblem = String(result).slice(0, 500);
          this._activeTask.nextExpectedAction = "recover the workspace-clear command from its last shell result";
          yield this._steer({
            detectedIntent: "DESTRUCTIVE_OPERATION",
            proposedAction: "failed workspace-clear command",
            recommendedAction: this._activeTask.nextExpectedAction,
            guidance: "Keep the workspace-clear task active. Analyze the shell result and choose a safe recovery command; do not report completion.",
          });
        } else {
          const answer = `Done. All files in ${this._workspace} were deleted and the folder was verified empty.`;
          this._messages.push({ role: "assistant", content: JSON.stringify({ tool: "bash", args }) });
          this._messages.push({ role: "user", content: `---TOOL RESULT: bash---\n${result}` });
          this._messages.push({ role: "assistant", content: answer });
          yield { type: "answer", content: answer };
          return;
        }
      }
    }

    // A plain directory-listing request has one deterministic implementation.
    // Running it here avoids semantically duplicate `find`, `ls`, and `glob`
    // calls that differ in syntax but return the same information.
    if (false && simpleFileListRequest(this._taskContract)) {
      const glob = this._registry.get("glob");
      if (glob) {
        const args = { pattern: "*", path: this._workspace, _agentWorkspace: this._workspace };
        yield { type: "tool-call", tool: "glob", args };
        let result;
        try {
          result = await glob.execute(args);
        } catch (error) {
          result = `Error: ${error.message}`;
        }
        yield { type: "tool-result", tool: "glob", result };
        const failed = resultFailed(result);
        this._toolEvidence.push({ tool: "glob", args: { ...args }, result, failed });
        this._executionPolicy.record("glob", args, result, failed);
        this._rememberInspection({ name: "glob", args }, result);
        if (failed) {
          this._activeTask.pendingProblem = String(result).slice(0, 500);
          this._activeTask.nextExpectedAction = "retry the relevant workspace inspection or use another inspection tool";
          yield this._steer({
            detectedIntent: "INSPECTION",
            proposedAction: "failed workspace listing",
            recommendedAction: this._activeTask.nextExpectedAction,
            guidance: "Keep the inspection task active. Use the failed result to choose a relevant inspection retry or fallback; do not report completion.",
          });
        } else {
          const answer = cachedToolAnswer({ name: "glob", args }, result);
          this._messages.push({ role: "assistant", content: JSON.stringify({ tool: "glob", args }) });
          this._messages.push({ role: "user", content: `---TOOL RESULT: glob---\n${result}` });
          this._messages.push({ role: "assistant", content: answer });
          yield { type: "answer", content: answer };
          return;
        }
      }
    }

    while (this._turn < this._config.maxTurns) {
      if (this._aborted || signal?.aborted) {
        yield { type: "answer", content: "The task was cancelled." };
        return;
      }
      this._turn++;
      this._stepBlocked = false;
      const snapshotPart = this._lifecycle.startStep();
      if (snapshotPart) yield { type: "tool-part", part: snapshotPart };
      yield { type: "thinking", turn: this._turn };

      const ctx = this._buildContext();
      let reply;
      let streamMode = "pending";
      let streamTail = "";
      let streamStarted = false;
      let streamVisibleLength = 0;
      let finalError = null;
      let nativeToolStream = false;
      const deferProse = Boolean(pendingProse);
      // A request must keep the model selected by the user for its complete
      // lifetime, including transport retries and malformed-tool recovery.
      // Tool-format variance is handled by the local parsers above; an
      // unrepairable response is redirected back to this same model.
      const requestModel = this._model;
      const maxAttempts = /(?:claude|anthropic)/i.test(String(requestModel)) ? 1 : 2;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        let chatErr;
        let receivedAnyToken = false;
        let typedStream = false;
        const eventQueue = [];
        let eventResolve = null;
        const queueEvent = event => {
          if (!event) return;
          if (eventResolve) {
            const resolveEvent = eventResolve;
            eventResolve = null;
            resolveEvent(event);
          } else {
            eventQueue.push(event);
          }
        };
        const compatibilityGuard = createAssistantTextGuard();
        const onToken = token => {
          this._markLatency("providerFirstDelta");
          receivedAnyToken = true;
          const text = compatibilityGuard.push(token);
          if (text) queueEvent({ type: "text-delta", text, compatibility: true });
        };
        const onEvent = event => {
          typedStream = true;
          if (["text-delta", "reasoning-delta", "tool-call-delta"].includes(event?.type)) {
            this._markLatency("providerFirstDelta");
            receivedAnyToken = true;
          }
          if (event?.type === "text-delta" && event.text) queueEvent(event);
          if (event?.type === "reasoning-delta" && event.text) queueEvent(event);
          if (event?.type === "tool-call-delta") nativeToolStream = true;
        };
        const nativeTools = (await this._registry.definitions({
          model: requestModel,
          agent: this._agentProfile?.name,
          directory: this._workspace,
        })).map(tool => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description || "",
            parameters: tool.parameters || { type: "object", properties: {} },
          },
        }));
        this._markLatency("requestDispatched");
        const chatDone = this._chat(ctx, {
          model: requestModel,
          onToken,
          onEvent,
          signal,
          tools: nativeTools,
        })
          .then(result => {
            if (typedStream) {
              reply = sanitizeAssistantIdentity(result);
              return;
            }
            const completed = compatibilityGuard.finish(result);
            if (completed.output) {
              queueEvent({ type: "text-delta", text: completed.output, compatibility: true });
            }
            reply = completed.text;
          })
          .catch(error => { chatErr = error; });
        const waitForEvent = () => new Promise(resolveEvent => { eventResolve = resolveEvent; });

        while (reply === undefined && chatErr === undefined) {
          const event = eventQueue.length > 0
            ? eventQueue.shift()
            : await Promise.race([waitForEvent(), chatDone.then(() => undefined)]);
          if (event === undefined) continue;
          if (event.type === "reasoning-delta") {
            yield { type: "reasoning", token: event.text };
            continue;
          }
          const token = event.text;
          if (typedStream && !event.compatibility) {
            streamMode = "text";
            streamStarted = true;
            streamVisibleLength += token.length;
            this._markLatency("uiFirstText");
            yield { type: "stream", token };
            continue;
          }
          streamTail += token;
          const disposition = streamDisposition(streamTail);
          if (disposition === "structured" || streamMode === "pending") streamMode = disposition;
          if (streamMode === "text" && !deferProse && streamTail.length > LEGACY_PROTOCOL_HOLDBACK) {
            const visible = streamTail.slice(0, -LEGACY_PROTOCOL_HOLDBACK);
            streamTail = streamTail.slice(-LEGACY_PROTOCOL_HOLDBACK);
            streamStarted = true;
            streamVisibleLength += visible.length;
            this._markLatency("uiFirstText");
            yield { type: "stream", token: visible };
          }
        }
        while (eventQueue.length > 0) {
          const event = eventQueue.shift();
          if (event.type === "reasoning-delta") {
            yield { type: "reasoning", token: event.text };
            continue;
          }
          const token = event.text;
          if (typedStream && !event.compatibility) {
            streamMode = "text";
            streamStarted = true;
            streamVisibleLength += token.length;
            this._markLatency("uiFirstText");
            yield { type: "stream", token };
            continue;
          }
          streamTail += token;
          const disposition = streamDisposition(streamTail);
          if (disposition === "structured" || streamMode === "pending") streamMode = disposition;
          if (streamMode === "text" && !deferProse && streamTail.length > LEGACY_PROTOCOL_HOLDBACK) {
            const visible = streamTail.slice(0, -LEGACY_PROTOCOL_HOLDBACK);
            streamTail = streamTail.slice(-LEGACY_PROTOCOL_HOLDBACK);
            streamStarted = true;
            streamVisibleLength += visible.length;
            this._markLatency("uiFirstText");
            yield { type: "stream", token: visible };
          }
        }
        await chatDone.catch(() => {});
        if (!chatErr) break;

        finalError = chatErr;
        if (streamStarted || receivedAnyToken) break;
        if (attempt < maxAttempts - 1) {
          try {
            await this._resetSession({ signal });
            reply = undefined;
            streamTail = "";
            streamMode = "pending";
            streamVisibleLength = 0;
            continue;
          } catch (resetError) {
            finalError = resetError;
          }
        }
        break;
      }

      if (finalError && reply === undefined) {
        if (streamStarted && streamMode === "text") {
          yield { type: "stream-discard" };
        }
        this._debugToolRecovery("transport_failure", finalError?.message || String(finalError));
        for (const lifecyclePart of this._lifecycle.finishStep("error")) {
          yield { type: "tool-part", part: lifecyclePart };
        }
        this._finishLatency();
        yield { type: "error", content: `Provider error: ${redactSecrets(finalError?.message || String(finalError))}` };
        return;
      }
      this._transportFailures = 0;

      if (!reply || !reply.trim() || reply.trim() === "{}" || reply.trim() === "[]") {
        for (const lifecyclePart of this._lifecycle.finishStep("error")) {
          yield { type: "tool-part", part: lifecyclePart };
        }
        this._finishLatency();
        yield { type: "error", content: "Provider returned an empty response." };
        return;
      }
      this._emptyResponses = 0;

      let parsed = nativeToolStream ? this._extractNativeTool(reply) : this._extractTool(reply);
      if (
        parsed.tools?.length > 1
        && parsed.tools.every(candidate => PARALLEL_READ_ONLY_TOOLS.has(this._normalizeTool(candidate).name))
      ) {
        yield { type: "stream-discard" };
        for await (const event of this._runReadOnlyBatch(parsed.tools)) yield event;
        if (this._loopRecoveryExhausted) {
          const answer = this._boundedLoopRecoveryAnswer();
          yield { type: "stream", token: answer };
          yield { type: "stream-end" };
          return;
        }
        if (this._stepBlocked) return;
        continue;
      }
      if (parsed.tools?.length > 1) {
        yield { type: "stream-discard" };
        for await (const event of this._runSequentialBatch(parsed.tools)) yield event;
        if (this._loopRecoveryExhausted) {
          const answer = this._boundedLoopRecoveryAnswer();
          yield { type: "stream", token: answer };
          yield { type: "stream-end" };
          return;
        }
        continue;
      }
      let tool = parsed.tool ? this._normalizeTool(parsed.tool) : null;
      if (tool) {
        const validation = validateToolArguments(tool, this._registry);
        if (validation) {
          parsed = { tool: null, error: validation.detail, kind: validation.kind, truncated: false };
          tool = null;
        }
      }

      if (parsed.error) {
        yield { type: "stream-discard" };
        this._debugToolRecovery(parsed.kind || "malformed_json", parsed.error);
        const part = this._lifecycle.pending({
          callId: randomUUID(),
          tool: "invalid_tool_call",
          input: { kind: parsed.kind || "malformed_json" },
        });
        this._lifecycle.running(part);
        this._lifecycle.failed(part, parsed.error);
        yield { type: "tool-part", part: { ...part } };
        yield {
          type: "tool-result",
          tool: "invalid_tool_call",
          result: part.state.error,
          callId: part.callId,
          failed: true,
        };
        this._messages.push({ role: "assistant", content: reply });
        this._messages.push({ role: "user", content: `---TOOL ERROR: invalid_tool_call---\n${part.state.error}` });
        for (const lifecyclePart of this._lifecycle.finishStep("tool-error")) {
          yield { type: "tool-part", part: lifecyclePart };
        }
        this._invalidToolResponses = 0;
        continue;
      }
      this._invalidToolResponses = 0;

      if (!tool) {
        let visibleReply = pendingProse ? joinProseContinuation(pendingProse, reply) : reply;
        const displayReply = visibleReply;
        if (false && proseLooksIncomplete(visibleReply) && proseContinuations < MAX_PROSE_CONTINUATIONS) {
          proseContinuations++;
          pendingProse = pendingProse
            ? visibleReply
            : (streamTail || reply.slice(streamVisibleLength));
          streamTail = "";
          this._messages.push({ role: "assistant", content: reply });
          this._messages.push({
            role: "user",
            content: "The previous response ended mid-content. Continue from the exact cutoff and finish the response.",
          });
          continue;
        }

        const plan = normalizePlan(extractPlan(visibleReply));
        if (false && plan.length > 0) {
          this._plan = plan;
          this._planIndex = 0;
          this._planningPhase = false;
          this._executionPolicy.setPhase("executing");
          yield { type: "plan", items: plan };
          this._messages.push({ role: "assistant", content: visibleReply });
          this._messages.push({ role: "user", content: "Begin the first pending plan item now. Use exactly one tool call when a tool is needed." });
          continue;
        }
        // Models sometimes ask the user in prose instead of calling the
        // question tool. Convert that observable output to an Ink interaction
        // so the UI remains selectable and never prints faux options as text.
        const interactiveQuestion = extractInteractiveQuestion(visibleReply);
        if (false && interactiveQuestion && this._questionHandler) {
          yield { type: "question", ...interactiveQuestion };
          let answer;
          try {
            answer = await this._questionHandler(interactiveQuestion);
          } catch {
            answer = "No answer provided";
          }
          this._messages.push({ role: "assistant", content: visibleReply });
          this._messages.push({ role: "user", content: `---USER ANSWER---\n${String(answer)}` });
          continue;
        }
        const missingEvidence = this._missingCompletionEvidence();
        if (missingEvidence) {
          yield { type: "stream-discard" };
          this._completionRedirects++;
          this._messages.push({ role: "assistant", content: reply });
          this._debugToolRecovery("completion_evidence", missingEvidence);
          if (this._taskContract.category === "GIT_OPERATION" && /auth|credential|password|token|permission denied|401|403/i.test(this._activeTask.lastToolResult || "")) {
            const answer = "The commit is stored locally, but push requires GitHub authentication. Provide a token or configure credentials to continue.";
            this._messages.push({ role: "assistant", content: answer });
            yield { type: "answer", content: answer };
            return;
          }
          const steering = this._completionSteering(missingEvidence);
          if (this._completionRedirects >= 3) {
            yield this._steer(steering);
            this._completionRedirects = 0;
            continue;
          }
          yield this._steer(steering);
          continue;
        }
        if (false && this._plan && this._planIndex < this._plan.length) {
          // A sentence such as "Next, I'll create..." is not completion. Keep
          // the remaining todos pending until their corresponding tool work has
          // actually finished, then continue the execution loop.
          this._planNarrations++;
          this._messages.push({ role: "assistant", content: reply });
          if (this._planNarrations >= 3) {
            yield this._steer({ detectedIntent: this._taskContract.category, proposedAction: "narrate pending work", recommendedAction: "execute the active plan item", guidance: `Execute plan item ${this._planIndex + 1} with one matching tool. Do not report completion until its result succeeds.` });
            this._planNarrations = 0;
            continue;
          }
          this._messages.push({
            role: "user",
            content: `Plan item ${this._planIndex + 1} of ${this._plan.length} is still pending: "${this._plan[this._planIndex].description}". Execute it with a tool now; do not narrate the next step.`,
          });
          continue;
        }
        if (false && this._requestMode === "mutate") {
          const answer = stripMarkdown(this._evidenceAnswer(visibleReply));
          this._messages.push({ role: "assistant", content: answer });
          this._clearPendingAction();
          yield { type: "stream", token: answer };
          yield { type: "stream-end" };
          return;
        }
        // Suppress only a verified tool call; normal prose must never disappear
        // merely because it contains the word "tool" or JSON as an example.
        if (pendingProse) {
          this._markLatency("uiFirstText");
          yield { type: "stream", token: displayReply };
        } else if (streamMode === "text") {
          if (streamTail) {
            this._markLatency("uiFirstText");
            yield { type: "stream", token: streamTail };
          }
        } else {
          // Non-tool structured text (for example a JSON answer) is released
          // only after parsing proves it is safe to show.
          const remaining = reply.slice(streamVisibleLength);
          if (remaining) {
            this._markLatency("uiFirstText");
            yield { type: "stream", token: remaining };
          }
        }
        this._messages.push({ role: "assistant", content: visibleReply });
        this._clearPendingAction();
        for (const lifecyclePart of this._lifecycle.finishStep("stop")) {
          yield { type: "tool-part", part: lifecyclePart };
        }
        this._finishLatency();
        yield { type: "stream-end" };
        return;
      }

      // Text emitted while the provider was still producing this response was
      // provisional. Once parsing proves it is a tool call, clients must drop
      // that draft instead of committing a truncated assistant message.
      yield { type: "stream-discard" };
      const auxiliaryTool = false;
      tool.id ||= randomUUID();
      const loopRecovery = this._toolLoopRecovery(tool);
      if (loopRecovery) {
        this._lifecycle.finishStep("tool-calls");
        if (loopRecovery.exhausted) {
          const answer = this._boundedLoopRecoveryAnswer();
          yield { type: "stream", token: answer };
          yield { type: "stream-end" };
          return;
        }
        continue;
      }
      this._messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: tool.id,
          type: "function",
          function: { name: tool.name, arguments: JSON.stringify(publicToolArgs(tool.args)) },
        }],
      });
      if (this._plan && this._planIndex < this._plan.length && !auxiliaryTool) {
        this._plan[this._planIndex].status = "running";
        yield { type: "plan-update", index: this._planIndex, status: "running" };
      }
      let result;
      let part;
      let finishReason = "tool-calls";
      for await (const event of this._toolExecutor().execute(tool, { agent: this._agentProfile?.name })) {
        if (event.type === "execution-result") {
          part = event.part;
          result = event.result;
          finishReason = event.finishReason;
          tool.args = event.call.args;
          tool.id = event.call.id;
        } else if (event.type === "tool-result") {
          // Add agent-specific metadata and optional LSP diagnostics below.
        } else {
          yield event;
        }
      }
      if (!part) continue;
      if (tool.name === "todowrite" && part.state.status === "completed") {
        const todos = Array.isArray(part.state.metadata?.todos) ? part.state.metadata.todos : [];
        this._plan = todos.map(todo => ({
          description: todo.content,
          status: todo.status === "completed" ? "done" : todo.status === "in_progress" ? "running" : "pending",
        }));
        this._planIndex = Math.max(0, this._plan.findIndex(item => item.status !== "done"));
        yield { type: "plan", items: this._plan };
      }
      result = redactSecrets(result);
      this._rememberToolOutcome(tool, result);
      if (["web", "webfetch", "websearch", "repo"].includes(tool.name)) {
        this._researchSources = [...new Set([...this._researchSources, ...sourceUrls(result)])].slice(0, 20);
      }
      const metadata = toolMetadata(tool, result);
      yield {
        type: "tool-result",
        tool: tool.name,
        result,
        metadata,
        callId: part.callId,
        failed: part.state.status === "error",
      };
      this._toolEvidence.push({
        tool: tool.name,
        args: { ...tool.args },
        result,
        failed: resultFailed(result),
        metadata,
      });
      this._lastToolResult = result;
      this._activeTask.lastToolResult = result.slice(0, 1500);
      this._activeTask.pendingProblem = part.state.status === "error" ? result.slice(0, 500) : "";
      this._lastToolIsRead = ["read", "glob", "grep"].includes(tool.name);
      this._lastToolWasExecuted = true;
      if (tool.name === "write") this._totalWrites++;
      this._messages.push({
        role: "tool",
        tool_call_id: part.callId,
        name: tool.name,
        content: result,
      });
      for (const lifecyclePart of this._lifecycle.finishStep(finishReason)) {
        yield { type: "tool-part", part: lifecyclePart };
      }
    }
    this._finishLatency();
    yield { type: "error", content: `Maximum step count reached (${this._config.maxTurns}).` };
  }
}
