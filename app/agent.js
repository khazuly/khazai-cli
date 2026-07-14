import { countTokens } from "../lib/tokens.js";
import { loadConfig, findProjectInstructions } from "../config/index.js";
import { chat, resetSession } from "../lib/llm.js";

import { execAsync } from "../lib/exec-async.js";
import { cleanInteractiveText } from "../lib/interactive-text.js";
import { ExecutionPolicy, destructiveCommand, inspectionCommand } from "./execution-policy.js";
import { IntentResolver, fallbackIntentContract, normalizeIntentContract } from "./intent-resolver.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
        { status: "pending", description: "Fetch the requested website home page" },
        { status: "pending", description: "Search the web for indexed pages on the requested domain" },
        { status: "pending", description: "Fetch a discovered public page from the requested domain" },
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
  const questions = lines.filter(line => /\?$/.test(line));
  const question = questions.at(-1);
  if (!question || !/\b(what|which|please|provide|choose|select|would you|do you|can you)\b/i.test(question)) {
    return null;
  }
  const options = lines
    .map(line => /^(?:[-*•])\s+(.+)$/.exec(line)?.[1]?.trim())
    .filter(Boolean)
    .filter((option, index, all) => all.indexOf(option) === index)
    .slice(0, 6);
  return { question, options };
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
  if (["change", "delete"].includes(contract?.intent)) return "mutate";
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
    || text.startsWith("BLOCKED:")
    || /^Exit:\s*(?!0\b)-?\d+/m.test(text);
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

function endpointDiscoveryTarget(contract, history = []) {
  if (contract?.operation !== "discover_endpoints") return null;
  const findUrl = value => /https?:\/\/[^\s<>"'`)\]]+/i.exec(String(value || ""))?.[0]?.replace(/[.,;:!?]+$/, "") || null;
  const direct = contract.targetUrl || findUrl(contract.request);
  if (direct) return direct;
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index]?.role !== "user" || String(history[index].content).startsWith("---")) continue;
    const previous = findUrl(history[index].content);
    if (previous) return previous;
  }
  return null;
}

export function expectedPlanTools(description) {
  const text = String(description).toLowerCase();
  if (/\b(?:github|git repository|repository|repo)\b/.test(text)) return ["repo", "web"];
  if (/\b(?:web\s*search|search (?:the )?web|search engine)\b/.test(text)) return ["websearch"];
  if (/\b(?:fetch|open).*(?:url|page|site|website)|\b(?:url|page|site|website).*(?:fetch|open)\b/.test(text)) return ["web"];
  if (/\b(?:create|write|implement|build|add)\b/.test(text)) return ["write", "edit"];
  if (/\b(?:edit|modify|update|fix)\b/.test(text)) return ["edit", "write"];
  if (/\b(?:run|test|validate)\b/.test(text)) return ["bash", "analyze"];
  if (/\b(?:list|find|scan)\b.*\bfiles?\b/.test(text)) return ["glob", "grep", "bash"];
  if (/\b(?:read|inspect)\b.*\bfiles?\b/.test(text)) return ["read", "glob", "grep", "analyze"];
  return null;
}

export function mutationSatisfiesPlanItem(tool, description) {
  if (!["write", "edit"].includes(tool?.name)) return false;
  const source = String(tool.args?.content ?? tool.args?.newString ?? "").toLowerCase();
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
  if (["write", "edit"].includes(tool.name)) {
    const path = String(tool.args?.path || "").toLowerCase();
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
  if (["write", "edit", "task"].includes(tool.name)) return true;
  return tool.name === "bash" && !isInspectionCommand(tool.args?.command);
}

export function streamDisposition(prefix) {
  const text = String(prefix).trimStart();
  if (!text) return "pending";
  // Claude may prefix a native-style tool wrapper with prose. Re-check the
  // uncommitted tail on every chunk so structured payloads never reach the UI.
  if (/<\s*\/?\s*(?:function|tool)_calls?/i.test(text)) return "structured";
  if (/<\s*invoke\b/i.test(text)) return "structured";
  if (/\{\s*["']tool["']\s*:/i.test(text)) return "structured";
  if (/\{\s*["'](?:read|write|edit|bash|glob|grep|analyze|web|websearch|repo|question|task)["']\s*:/i.test(text)) {
    return "structured";
  }
  if (text.startsWith("{")) return "structured";
  if (/^(?:tool\s*:\s*)?(?:read|write|edit|bash|glob|grep|analyze|web|websearch|repo|question|task)\s*\(/i.test(text)) {
    return "structured";
  }
  if (/^tool\s*:\s*(?:read|write|edit|bash|glob|grep|analyze|web|websearch|repo|question|task)\b/i.test(text)) {
    return "structured";
  }
  if (text.startsWith("[")) {
    if (/^\[\s*[ .xX]\s*\]/.test(text)) return "structured";
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

const STREAM_TAIL_CHARS = 160;
const MAX_PROSE_CONTINUATIONS = 2;

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
    this._registry = registry;
    this._config = loadConfig();
    this._model = opts.model || this._config.model;
    this._workspace = opts.workspace || process.cwd();
    this._messages = [];
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
    this._lastToolSignature = null;
    this._lastToolResult = null;
    this._repeatedToolCalls = 0;
    this._questionHandler = opts.questionHandler || null;
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
    this._emptyResponses = 0;
    this._toolEvidence = [];
    this._inspectionCache = new Map();
    this._workspaceListing = null;
    this._cachedInspectionRedirects = 0;
    this._completionRedirects = 0;
    this._acceptedCreationOffer = null;
    this._resolvedArtifactDocumentation = false;
    this._executionPolicy = null;
    this._taskContract = fallbackIntentContract("");
    this._chat = opts.chat || chat;
    this._resetSession = opts.resetSession || resetSession;
    const configuredResolver = opts.intentResolver;
    this._intentResolver = typeof configuredResolver === "function"
      ? { resolve: configuredResolver }
      : configuredResolver?.resolve
        ? configuredResolver
        : new IntentResolver({ classify: opts.intentChat || this._chat });
  }

  abort() { this._aborted = true; }
  setModel(model) { this._model = model; }
  setQuestionHandler(handler) { this._questionHandler = handler; }

  _rememberInspection(tool, result) {
    if (resultFailed(result) || !["read", "glob", "grep", "analyze"].includes(tool.name)) return;
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

  _cleanAnswer(text) {
    let clean = text
      .replace(/^final answer\s*:?\s*/im, "")
      .replace(/```\w*\n[\s\S]*?```/g, (m) => {
        const code = m.replace(/```\w*\n?/g, "").trim();
        return code;
      })
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return clean;
  }

  _missingCompletionEvidence() {
    const policyDirective = this._executionPolicy?.completionDirective();
    if (policyDirective) return policyDirective;
    if (this._requestMode !== "mutate") return null;
    const successful = this._toolEvidence.filter(entry => !entry.failed);
    const mutations = successful.filter(entry => ["write", "edit"].includes(entry.tool));

    if (needsDeletionMutation(this._taskContract)) {
      const deleted = successful.some(entry => entry.tool === "bash" && isDeletionCommand(entry.args?.command));
      if (!deleted) return "No requested deletion has completed successfully.";
    }

    if (needsFileMutation(this._taskContract) && mutations.length === 0) {
      return "No requested file mutation has completed successfully.";
    }

    const extensions = requestedSampleExtensions(this._taskContract);
    if (extensions.length > 0) {
      const paths = mutations.map(entry => String(entry.args?.path || "").toLowerCase());
      const missing = extensions.filter(extension => !paths.some(path => path.endsWith(extension)));
      if (missing.length > 0) return `Missing requested sample files: ${missing.join(", ")}.`;
      if (extensions.length > 1) {
        const stemsByExtension = extensions.map(extension => new Set(paths
          .filter(path => path.endsWith(extension))
          .map(path => path.slice(0, -extension.length))));
        const paired = [...stemsByExtension[0]].some(stem => stemsByExtension.every(stems => stems.has(stem)));
        if (!paired) return `Requested sample files must form a matching ${extensions.join("/")} pair with the same basename.`;
      }
    }

    if (needsExecutionValidation(this._taskContract)) {
      const validated = successful.some(entry => entry.tool === "bash" && isValidationCommand(entry.args?.command, this._taskContract.domain));
      if (!validated) return "The requested execution test has not run successfully.";
    }
    return null;
  }

  _evidenceAnswer(fallback) {
    const successful = this._toolEvidence.filter(entry => !entry.failed);
    const paths = [...new Set(successful
      .filter(entry => ["write", "edit"].includes(entry.tool))
      .map(entry => String(entry.args?.path || ""))
      .filter(Boolean))];
    const validation = successful.findLast(entry => entry.tool === "bash" && isValidationCommand(entry.args?.command, this._taskContract.domain));
    const sources = successful
      .filter(entry => ["write", "edit"].includes(entry.tool))
      .map(entry => String(entry.args?.content ?? entry.args?.newString ?? ""))
      .join("\n");
    const base64Only = /\bbase64\b/i.test(sources) && !/\bAES\b|cryptography|Crypto\.Cipher/i.test(sources);

    const clean = this._cleanAnswer(fallback);
    const unsupportedAes = /\bAES(?:-\d+)?(?:-(?:CBC|GCM))?\b/i.test(clean) && !/\bAES\b|Crypto\.Cipher/i.test(sources);
    if (clean && !unsupportedAes) return clean;

    const lines = ["Completed successfully."];
    if (paths.length) lines.push("Files created or updated:", ...paths.map(path => `- ${path}`));
    if (validation) lines.push(`Validation passed: ${validation.args.command}`);
    if (base64Only && this._taskContract.domain === "obfuscation") {
      lines.push("Note: the implementation uses Base64 encoding/obfuscation, not cryptographic encryption.");
    }
    return lines.join("\n");
  }

  _buildSystem() {
    const parts = [
      this._config.system,
      "",
      "You are an autonomous developer working with the user inside one workspace.",
      "",
      "EXECUTION WORKFLOW:",
      "1. Understand the current outcome and use conversation context for short follow-ups.",
      "2. Inspect only the evidence needed to choose a safe action.",
      "3. For a complex task, form a concrete plan; otherwise act directly.",
      "4. Execute one tool at a time and use its actual result to choose the next step.",
      "5. Recover from failures by changing the action based on the error, not by repeating it.",
      "6. Verify requested outcomes with tests or observable state when applicable.",
      "7. Give a final answer only when the task state shows the requested outcome is complete.",
      "",
      "DECISION CONTRACT:",
      "- If an observable action is required, call a tool instead of describing the action.",
      "- Never claim that a file was created, changed, deleted, tested, fetched, or executed without a successful tool result.",
      "- Do not restart completed research or repeat an equivalent inspection when existing evidence answers the question.",
      "- Preserve unrelated workspace changes and stay within the user's requested scope.",
      "- Ask a question only when a missing choice materially changes the implementation; otherwise make a safe assumption and proceed.",
      "- On failure, inspect the error and select a different recovery action. Do not retry an identical failed call.",
      "- Do not start long-lived foreground servers. Prepare the project and report the command the user can run.",
      "",
      "TOOL PROTOCOL:",
      "- Respond with EXACTLY one JSON object: {\"tool\":\"name\",\"args\":{...}}",
      "- No text before or after the JSON. No markdown. No explanation.",
      "- Use normal concise prose only when no further tool action is needed.",
      "",
      `WORKSPACE: ${this._workspace}`,
      "",
    ];
    if (this._executionPolicy) {
      parts.push("CURRENT TASK STATE:", this._executionPolicy.contextBlock(), "");
    }
    if (this._lastAnalysis) {
      parts.push("LATEST ANALYSIS:", this._lastAnalysis, "");
    }
    const proj = findProjectInstructions();
    if (proj) parts.push("Project instructions:", proj, "");
    if (this._planningPhase) {
      parts.push(
        "Planning phase: return only a concise checklist in this exact format:",
        "[ ] First concrete action",
        "[ ] Next concrete action",
        "[ ] Validation action",
        "Do not call tools in this response.",
        "",
      );
    }
    parts.push(this._registry.buildPromptBlock());
    return parts.join("\n");
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
      return { name: parsed.tool, args: parsed.args };
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

  _extractTool(text) {
    const reply = text.trim();
    const toolNames = this._registry.list().map(t => t.name).join("|");

    try {
      const parsed = JSON.parse(reply);
      const tool = this._parseToolJson(parsed);
      if (tool) return { tool, error: null };
    } catch {}

    for (const candidate of extractJsonCandidates(reply)) {
      try {
        const parsed = JSON.parse(candidate);
        const tool = this._parseToolJson(parsed);
        if (tool) return { tool, error: null };
      } catch { continue; }
    }

    const taggedTool = extractTaggedToolCall(reply, this._registry);
    if (taggedTool) return { tool: taggedTool, error: null };

    const toolLike = /<\s*\/?\s*(?:function|tool)_calls?/i.test(reply)
      || /<\s*(?:invoke|tool_call)\b/i.test(reply)
      || /["']tool["']\s*:/i.test(reply)
      || /["'](?:tool_calls|function_calls|tool_use)["']\s*:/i.test(reply)
      || new RegExp(`["'](?:${toolNames})["']\\s*:`).test(reply);
    if (toolLike) {
      const opensJson = /[\[{]/.test(reply);
      const closesJson = /[\]}]\s*(?:```|<\/\s*(?:function|tool)_calls?>)?\s*$/i.test(reply);
      const truncated = opensJson && !closesJson;
      return {
        tool: null,
        error: truncated
          ? "The tool call was truncated before its JSON payload completed."
          : "Found tool-like text but could not parse a valid JSON tool call.",
        truncated,
      };
    }

    return { tool: null, error: null };
  }

  _normalizeTool(tool) {
    if (tool?.name !== "read" || !this._registry.get("glob")) return tool;
    const requestedPath = String(tool.args?.path || "");
    if (!requestedPath) return tool;
    const targetPath = requestedPath.startsWith("/")
      ? requestedPath
      : resolve(this._workspace, requestedPath);
    try {
      if (statSync(targetPath).isDirectory()) {
        return { name: "glob", args: { pattern: "*", path: targetPath } };
      }
    } catch {}
    return tool;
  }

  _compactMessages() {
    const KEEP_RECENT = 14;
    if (this._messages.length <= KEEP_RECENT + 4) return;

    const compacted = [{ role: "user", content: "(Earlier turns: tools executed, edits applied, analyses completed. Details compacted to save context.)" }];
    this._messages = [this._messages[0], ...compacted, ...this._messages.slice(-KEEP_RECENT)];
  }

  _buildContext() {
    const ctx = [];
    let used = 0;
    const sys = this._buildSystem();

    // The current request is the task anchor. Using the first request from a
    // long session here made follow-up requests look like stale continuations.
    const userContent = this._currentRequest || this._messages.at(-1)?.content || "";

    ctx.push({ role: "user", content: `[System]\n${sys}\n\n${userContent}` });
    used += countTokens(sys) + countTokens(userContent);

    const requestStart = Math.max(0, Math.min(this._requestStartIndex, this._messages.length));
    const historical = this._messages
      .slice(0, requestStart)
      .filter(message => {
        const content = String(message.content || "").trim();
        if (!content || content.startsWith("---") || content.startsWith("[System]")) return false;
        if (message.role === "assistant" && streamDisposition(content) === "structured") return false;
        return message.role === "user" || message.role === "assistant";
      })
      .slice(-4)
      .map(message => ({ ...message, content: String(message.content).slice(0, 1200) }));
    const currentTurn = this._messages.slice(requestStart + 1);
    const candidates = [...historical, ...currentTurn];

    for (let index = candidates.length - 1; index >= 0; index--) {
      const m = candidates[index];
      const sz = countTokens(m.content);
      if (used + sz > this._config.tokenBudget) continue;
      ctx.splice(1, 0, m);
      used += sz;
    }

    return ctx;
  }

  async *loop(input, signal) {
    this._compactMessages();
    const previousMessages = this._messages.slice();
    const previousRequest = this._currentRequest;
    const previousAssistant = previousMessages.findLast(message =>
      message.role === "assistant" && streamDisposition(message.content) !== "structured")?.content || "";
    let taskContract;
    try {
      taskContract = await this._intentResolver.resolve({
        input,
        previousRequest,
        previousAssistant,
        history: previousMessages,
        model: this._model,
        signal,
      });
    } catch {
      taskContract = fallbackIntentContract(input);
    }
    this._taskContract = normalizeIntentContract(taskContract, input);
    const creationOffer = this._taskContract.continuation === "accept_offer"
      ? String(previousAssistant).slice(0, 1200)
      : null;
    const implementationContinuation = this._taskContract.continuation === "refine_existing" && previousRequest
      ? `${input}\n\nContinuation of previous implementation:\n${String(previousRequest).slice(0, 1200)}`
      : null;
    this._messages.push({ role: "user", content: input });
    this._requestStartIndex = this._messages.length - 1;
    this._currentRequest = creationOffer
      ? `${input}\n\nAccepted implementation offer: ${creationOffer}`
      : implementationContinuation || input;
    this._acceptedCreationOffer = creationOffer;
    this._requestMode = requestMode(this._taskContract);
    this._requiresPlan = implementationContinuation ? false : requiresPlan(this._taskContract);
    this._planningPhase = this._requiresPlan;
    this._turn = 0;
    this._aborted = false;
    this._lastToolWasExecuted = false;
    this._totalWrites = 0;
    this._plan = null;
    this._planIndex = 0;
    this._lastToolSignature = null;
    this._lastToolResult = null;
    this._repeatedToolCalls = 0;
    this._inspectionCommands.clear();
    this._readOnlyRedirects = 0;
    this._planNarrations = 0;
    this._planMismatches = 0;
    this._postPlanToolRedirects = 0;
    this._invalidToolResponses = 0;
    this._emptyResponses = 0;
    this._toolEvidence = [];
    this._cachedInspectionRedirects = 0;
    this._completionRedirects = 0;
    this._resolvedArtifactDocumentation = false;
    this._executionPolicy = new ExecutionPolicy(this._taskContract, { planning: this._planningPhase });
    let pendingProse = "";
    let proseContinuations = 0;

    const discoveryTarget = endpointDiscoveryTarget(this._taskContract, previousMessages);
    if (discoveryTarget) {
      this._requestMode = "read-only";
      this._planningPhase = false;
      this._plan = [{ status: "pending", description: "Inspect HTML, JavaScript bundles, chunks, source maps, and endpoint candidates" }];
      this._planIndex = 0;
      yield { type: "plan", items: this._plan };
      this._plan[0].status = "running";
      yield { type: "plan-update", index: 0, status: "running" };
      const args = { url: discoveryTarget, discover: true, maxAssets: 500 };
      yield { type: "tool-call", tool: "web", args };
      const web = this._registry.get("web");
      let result;
      try {
        result = web ? await web.execute(args) : "Error: web tool is unavailable";
      } catch (error) {
        result = `Error: ${error.message}`;
      }
      yield { type: "tool-result", tool: "web", result };
      const failed = result.startsWith("Error:");
      this._executionPolicy.record("web", args, result, failed);
      this._plan[0].status = failed ? "failed" : "done";
      yield { type: "plan-update", index: 0, status: this._plan[0].status };
      this._planIndex = 1;
      this._messages.push({ role: "developer", content: JSON.stringify({ tool: "web", args }) });
      this._messages.push({ role: "user", content: `---ENDPOINT DISCOVERY RESULT---\n${result}` });
      if (failed) {
        yield { type: "error", content: result };
      } else {
        yield { type: "answer", content: result };
      }
      return;
    }

    // Clearing a workspace is unambiguous when the user explicitly asks to
    // remove every file. Execute it locally instead of trusting a model to call
    // a destructive tool or accepting an unsupported "done" claim. `find`
    // handles hidden entries as well, and the final `test` verifies the exact
    // workspace root is empty before completion is reported.
    if (clearWorkspaceRequest(this._taskContract)) {
      const bash = this._registry.get("bash");
      if (!bash) {
        yield { type: "error", content: "The shell tool is unavailable, so the workspace was not cleared." };
        return;
      }
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
        const answer = "The workspace was not cleared. Check the Shell result above.";
        this._messages.push({ role: "developer", content: answer });
        yield { type: "answer", content: answer };
        return;
      }
      const answer = `Done. All files in ${this._workspace} were deleted and the folder was verified empty.`;
      this._messages.push({ role: "developer", content: JSON.stringify({ tool: "bash", args }) });
      this._messages.push({ role: "user", content: `---TOOL RESULT: bash---\n${result}` });
      this._messages.push({ role: "developer", content: answer });
      yield { type: "answer", content: answer };
      return;
    }

    // A plain directory-listing request has one deterministic implementation.
    // Running it here avoids semantically duplicate `find`, `ls`, and `glob`
    // calls that differ in syntax but return the same information.
    if (simpleFileListRequest(this._taskContract)) {
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
          yield { type: "error", content: result };
          return;
        }
        const answer = cachedToolAnswer({ name: "glob", args }, result);
        this._messages.push({ role: "developer", content: JSON.stringify({ tool: "glob", args }) });
        this._messages.push({ role: "user", content: `---TOOL RESULT: glob---\n${result}` });
        this._messages.push({ role: "developer", content: answer });
        yield { type: "answer", content: answer };
        return;
      }
    }

    while (this._turn < this._config.maxTurns) {
      if (this._aborted || signal?.aborted) {
        yield { type: "error", content: "Aborted" };
        return;
      }
      this._turn++;
      yield { type: "thinking", turn: this._turn };

      const ctx = this._buildContext();
      let reply;
      let streamMode = "pending";
      let streamTail = "";
      let streamStarted = false;
      let streamVisibleLength = 0;
      let finalError = null;
      const deferProse = shouldDeferToolCandidateProse(
        this._taskContract,
        Boolean(this._plan && this._planIndex < this._plan.length),
      )
        || Boolean(pendingProse);
      // A request must keep the model selected by the user for its complete
      // lifetime, including transport retries and malformed-tool recovery.
      // Tool-format variance is handled by the local parsers above; an
      // unrepairable response is redirected back to this same model.
      const requestModel = this._model;
      const maxAttempts = /(?:claude|anthropic)/i.test(String(requestModel)) ? 1 : 2;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        let chatErr;
        let receivedAnyToken = false;
        const tokenQueue = [];
        let tokenResolve = null;
        const onToken = token => {
          receivedAnyToken = true;
          if (tokenResolve) {
            const resolveToken = tokenResolve;
            tokenResolve = null;
            resolveToken(token);
          } else {
            tokenQueue.push(token);
          }
        };
        const chatDone = this._chat(ctx, { model: requestModel, onToken, signal })
          .then(result => { reply = result; })
          .catch(error => { chatErr = error; });
        const waitForToken = () => new Promise(resolveToken => { tokenResolve = resolveToken; });

        while (reply === undefined && chatErr === undefined) {
          const token = tokenQueue.length > 0
            ? tokenQueue.shift()
            : await Promise.race([waitForToken(), chatDone.then(() => undefined)]);
          if (token === undefined) continue;
          streamTail += token;
          const disposition = streamDisposition(streamTail);
          if (disposition === "structured" || streamMode === "pending") streamMode = disposition;
          if (streamMode === "text" && !deferProse && streamTail.length > STREAM_TAIL_CHARS) {
            const visible = streamTail.slice(0, -STREAM_TAIL_CHARS);
            streamTail = streamTail.slice(-STREAM_TAIL_CHARS);
            streamStarted = true;
            streamVisibleLength += visible.length;
            yield { type: "stream", token: visible };
          }
        }
        while (tokenQueue.length > 0) {
          const token = tokenQueue.shift();
          streamTail += token;
          const disposition = streamDisposition(streamTail);
          if (disposition === "structured" || streamMode === "pending") streamMode = disposition;
          if (streamMode === "text" && !deferProse && streamTail.length > STREAM_TAIL_CHARS) {
            const visible = streamTail.slice(0, -STREAM_TAIL_CHARS);
            streamTail = streamTail.slice(-STREAM_TAIL_CHARS);
            streamStarted = true;
            streamVisibleLength += visible.length;
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
          if (streamTail) yield { type: "stream", token: streamTail };
          yield { type: "stream-end" };
        }
        yield { type: "error", content: `LLM error: ${finalError.message}` };
        return;
      }

      if (!reply || !reply.trim() || reply.trim() === "{}" || reply.trim() === "[]") {
        this._emptyResponses++;
        if (this._emptyResponses >= 2) {
          yield { type: "error", content: "Stopped: the model returned two empty responses without an actionable tool call." };
          return;
        }
        this._messages.push({ role: "user", content: "The LLM returned an empty response. Retry the last action directly. Do not explain." });
        continue;
      }
      this._emptyResponses = 0;

      const parsed = this._extractTool(reply);
      const tool = parsed.tool ? this._normalizeTool(parsed.tool) : null;

      if (parsed.error) {
        this._invalidToolResponses++;
        if (this._invalidToolResponses >= 3) {
          yield { type: "error", content: `The selected model returned three consecutive unparseable tool calls. ${parsed.error}` };
          return;
        }
        const recoveryAttempt = this._invalidToolResponses;
        this._messages.push({
          role: "user",
          content: parsed.truncated
            ? `Tool recovery attempt ${recoveryAttempt}: the previous payload was truncated. Retry the same action as one complete tool call with a concise implementation under 6000 source characters. Keep the requested behavior, but omit nonessential comments and abstractions.`
            : `Tool recovery attempt ${recoveryAttempt}: ${parsed.error} Return the same action as one complete, parseable tool call.`,
        });
        continue;
      }
      this._invalidToolResponses = 0;

      if (!tool) {
        const visibleReply = pendingProse ? joinProseContinuation(pendingProse, reply) : reply;
        if (proseLooksIncomplete(visibleReply) && proseContinuations < MAX_PROSE_CONTINUATIONS) {
          proseContinuations++;
          pendingProse = pendingProse
            ? visibleReply
            : (streamTail || reply.slice(streamVisibleLength));
          streamTail = "";
          this._messages.push({ role: "developer", content: reply });
          this._messages.push({
            role: "user",
            content: "The previous response ended mid-content. Continue from the exact cutoff and finish the response.",
          });
          continue;
        }

        const plan = normalizePlan(extractPlan(visibleReply));
        if (plan.length > 0) {
          this._plan = plan;
          this._planIndex = 0;
          this._planningPhase = false;
          this._executionPolicy.setPhase("executing");
          yield { type: "plan", items: plan };
          this._messages.push({ role: "developer", content: visibleReply });
          this._messages.push({ role: "user", content: "Begin the first pending plan item now. Use exactly one tool call when a tool is needed." });
          continue;
        }
        const missingEvidence = this._missingCompletionEvidence();
        if (missingEvidence) {
          this._completionRedirects++;
          this._messages.push({ role: "developer", content: reply });
          if (this._completionRedirects >= 3) {
            const answer = `The task is not complete because required execution evidence is still missing. ${missingEvidence}`;
            this._messages.push({ role: "developer", content: answer });
            yield { type: "answer", content: answer };
            return;
          }
          this._messages.push({
            role: "user",
            content: `${missingEvidence} Continue the current request with the required tool action.`,
          });
          continue;
        }
        // Models sometimes ask the user in prose instead of calling the
        // question tool. Convert that observable output to an Ink interaction
        // so the UI remains selectable and never prints faux options as text.
        const interactiveQuestion = extractInteractiveQuestion(visibleReply);
        if (interactiveQuestion && this._questionHandler) {
          yield { type: "question", ...interactiveQuestion };
          let answer;
          try {
            answer = await this._questionHandler(interactiveQuestion);
          } catch {
            answer = "No answer provided";
          }
          this._messages.push({ role: "developer", content: visibleReply });
          this._messages.push({ role: "user", content: `---USER ANSWER---\n${String(answer)}` });
          continue;
        }
        if (this._plan && this._planIndex < this._plan.length) {
          // A sentence such as "Next, I'll create..." is not completion. Keep
          // the remaining todos pending until their corresponding tool work has
          // actually finished, then continue the execution loop.
          this._planNarrations++;
          this._messages.push({ role: "developer", content: reply });
          if (this._planNarrations >= 3) {
            yield { type: "error", content: "Stopped: the plan still has pending items, but the model kept narrating instead of executing them." };
            return;
          }
          this._messages.push({
            role: "user",
            content: `Plan item ${this._planIndex + 1} of ${this._plan.length} is still pending: "${this._plan[this._planIndex].description}". Execute it with a tool now; do not narrate the next step.`,
          });
          continue;
        }
        if (this._requestMode === "mutate") {
          const answer = this._evidenceAnswer(visibleReply);
          this._messages.push({ role: "developer", content: answer });
          yield { type: "stream", token: answer };
          yield { type: "stream-end" };
          return;
        }
        // Suppress only a verified tool call; normal prose must never disappear
        // merely because it contains the word "tool" or JSON as an example.
        if (pendingProse) {
          yield { type: "stream", token: visibleReply };
        } else if (streamMode === "text") {
          if (streamTail) yield { type: "stream", token: streamTail };
        } else {
          // Non-tool structured text (for example a JSON answer) is released
          // only after parsing proves it is safe to show.
          const remaining = reply.slice(streamVisibleLength);
          if (remaining) yield { type: "stream", token: remaining };
        }
        this._messages.push({ role: "developer", content: visibleReply });
        yield { type: "stream-end" };
        return;
      }

      // A short affirmative follow-up can accept an implementation
      // that the assistant already offered after completing its research.
      // Do not execute another web-research cycle; redirect the selected model
      // to the requested workspace mutation while preserving model identity.
      if (this._acceptedCreationOffer && ["web", "websearch"].includes(tool.name)) {
        this._messages.push({
          role: "developer",
          content: JSON.stringify({ tool: tool.name, args: tool.args }),
        });
        this._messages.push({
          role: "user",
          content: `The user accepted this implementation offer: "${this._acceptedCreationOffer}". The research phase is already complete. Create the implementation in the workspace now with write or edit.`,
        });
        continue;
      }

      if (this._resolvedArtifactDocumentation && ["web", "websearch"].includes(tool.name)) {
        this._messages.push({
          role: "developer",
          content: JSON.stringify({ tool: tool.name, args: tool.args }),
        });
        this._messages.push({
          role: "user",
          content: "Package metadata and its repository README were already resolved successfully. Use the collected documentation to answer or implement the request without another web tool.",
        });
        continue;
      }

      const t = this._registry.get(tool.name);
      if (this._planningPhase && !this._plan) {
        // Planning is a UI contract for complex requests. If a model skips the
        // planning response and calls a tool immediately, provide a safe
        // fallback checklist before executing that first tool.
        this._plan = fallbackPlan(this._taskContract);
        this._planIndex = 0;
        this._planningPhase = false;
        yield { type: "plan", items: this._plan };
        const rawPath = String(tool.args?.path || "");
        const targetPath = rawPath && !rawPath.startsWith("/") ? resolve(this._workspace, rawPath) : rawPath;
        const createsNewFile = tool.name === "write" && targetPath && !existsSync(targetPath);
        if (createsNewFile && this._plan.length > 1 && /\binspect\b/i.test(this._plan[0].description)) {
          this._plan[0].status = "skipped";
          this._planIndex = 1;
          yield { type: "plan-update", index: 0, status: "skipped" };
        }
      }
      if (this._requestMode === "read-only" && mutatesWorkspace(tool)) {
        this._readOnlyRedirects++;
        this._messages.push({ role: "developer", content: JSON.stringify({ tool: tool.name, args: tool.args }) });
        if (this._readOnlyRedirects > 1) {
          yield { type: "error", content: "Stopped: this request is read-only, but the model kept requesting workspace changes." };
          return;
        }
        const attemptedCommand = String(tool.args?.command || "");
        const useWebTool = tool.name === "bash" && /\b(?:curl|wget)\b/i.test(attemptedCommand);
        this._messages.push({
          role: "user",
          content: useWebTool
            ? "The shell network request was blocked. Use the web or websearch tool for this read-only request."
            : "Workspace changes were blocked because the current user request asks for information only. Answer the current request directly without changing files.",
        });
        continue;
      }

      if (this._executionPolicy.contract.intent === "validate" && ["write", "edit"].includes(tool.name)) {
        const failedExecution = this._executionPolicy.evidence.some(entry => entry.tool === "bash" && entry.failed);
        this._messages.push({ role: "developer", content: JSON.stringify({ tool: tool.name, args: tool.args }) });
        if (!failedExecution) {
          this._messages.push({
            role: "user",
            content: "No execution failure has been observed. Run the existing artifact first. Do not create or rewrite files before validation produces an actual error.",
          });
          continue;
        }

        const rawPath = String(tool.args?.path || "");
        const targetPath = rawPath.startsWith("/") ? rawPath : resolve(this._workspace, rawPath);
        if (!rawPath || !existsSync(targetPath)) {
          this._messages.push({
            role: "user",
            content: "Validation failed, but this proposed target is not an existing file. Inspect and repair the existing implementation that produced the failure; do not create a replacement artifact.",
          });
          continue;
        }
        const inspected = this._toolEvidence.some(entry => !entry.failed
          && entry.tool === "read"
          && resolve(String(entry.args?.path || "")) === resolve(targetPath));
        if (!inspected) {
          this._messages.push({
            role: "user",
            content: `Read the existing file ${targetPath} before repairing it. Preserve its current implementation and public structure.`,
          });
          continue;
        }
        const existing = readFileSync(targetPath, "utf-8");
        const candidate = prospectiveFileContent(tool, existing);
        if (candidate !== null && !preservesImplementationStructure(existing, candidate)) {
          this._messages.push({
            role: "user",
            content: `The proposed change replaces the existing implementation in ${targetPath}. Repair the observed error in place while preserving its existing classes and functions.`,
          });
          continue;
        }
        // The tool call was recorded above while it was being validated. Avoid
        // adding a duplicate assistant message before normal execution.
        this._messages.pop();
      }

      if (this._requestMode === "read-only" && this._plan && this._planIndex >= this._plan.length) {
        this._postPlanToolRedirects++;
        this._messages.push({ role: "developer", content: JSON.stringify({ tool: tool.name, args: tool.args }) });
        if (this._postPlanToolRedirects >= 3) {
          yield { type: "error", content: "Stopped: the research todo is complete, but the model kept requesting more tools." };
          return;
        }
        this._messages.push({
          role: "user",
          content: "The research todo is complete. Produce the final answer using the collected tool results.",
        });
        continue;
      }

      const activePlanItem = this._plan && this._planIndex < this._plan.length
        ? this._plan[this._planIndex]
        : null;
      const mismatchesPlan = activePlanItem && !toolMatchesPlanItem(tool, activePlanItem.description);
      const auxiliaryInspection = mismatchesPlan && !mutatesWorkspace(tool);
      const validationTodo = activePlanItem
        && (expectedPlanTools(activePlanItem.description) || []).includes("bash");
      const auxiliarySetup = validationTodo
        && (tool.name !== "bash" || !isValidationCommand(tool.args?.command, this._taskContract.domain));
      const auxiliaryDependencyFile = mismatchesPlan
        && tool.name === "write"
        && /(?:^|\/)(?:requirements(?:-[^/]*)?\.txt|package\.json|pyproject\.toml)$/i.test(String(tool.args?.path || ""));
      const auxiliaryTool = auxiliaryInspection || auxiliarySetup || auxiliaryDependencyFile;

      if (mismatchesPlan && !auxiliaryTool) {
        this._planMismatches++;
        const expected = expectedPlanTools(this._plan[this._planIndex].description) || [];
        this._messages.push({ role: "developer", content: JSON.stringify({ tool: tool.name, args: tool.args }) });
        if (this._planMismatches >= 3) {
          yield { type: "error", content: `Stopped: the model repeatedly selected the wrong tool for todo ${this._planIndex + 1}.` };
          return;
        }
        this._messages.push({
          role: "user",
          content: `The current todo can only be executed with: ${expected.join(", ")}. Select one matching tool.`,
        });
        continue;
      }
      this._planMismatches = 0;
      if (tool.name === "question" && t) {
        if (this._requestMode === "mutate" && needsFileMutation(this._taskContract) && this._toolEvidence.length === 0) {
          this._completionRedirects++;
          if (this._completionRedirects >= 3) {
            yield { type: "error", content: "Stopped: the model repeatedly asked questions instead of performing the requested file change." };
            return;
          }
          this._messages.push({ role: "developer", content: JSON.stringify({ tool: tool.name, args: tool.args }) });
          this._messages.push({ role: "user", content: "The request already contains enough information for a first implementation. Perform the file change now." });
          continue;
        }
        if (!this._questionHandler) {
          yield { type: "error", content: "Interactive questions are unavailable in this session." };
          return;
        }
        const question = cleanInteractiveText(tool.args?.question || "Please choose an option.");
        const options = Array.isArray(tool.args?.options)
          ? tool.args.options.map(cleanInteractiveText).filter(Boolean)
          : [];
        yield { type: "question", question, options };
        let answer;
        try {
          answer = await this._questionHandler({ question, options });
        } catch {
          answer = "No answer provided";
        }
        this._messages.push({ role: "developer", content: JSON.stringify({ tool: tool.name, args: tool.args }) });
        this._messages.push({ role: "user", content: `---USER ANSWER---\n${String(answer)}` });
        continue;
      }

      this._messages.push({
        role: "developer",
        content: JSON.stringify({ tool: tool.name, args: tool.args }),
      });
      const signature = toolSignature(tool, this._workspace);
      this._repeatedToolCalls = signature === this._lastToolSignature
        ? this._repeatedToolCalls + 1
        : 1;
      this._lastToolSignature = signature;
      const cachedInspection = this._inspectionCache.get(signature);
      const asksToInspectFiles = this._taskContract.operation === "inspect_code";
      if (tool.name === "glob" && asksToInspectFiles && this._workspaceListing) {
        this._cachedInspectionRedirects++;
        if (this._cachedInspectionRedirects >= 3) {
          const answer = "The workspace listing is already available. Read a listed file to inspect its contents.";
          this._messages.push({ role: "developer", content: answer });
          yield { type: "answer", content: answer };
          return;
        }
        this._messages.push({
          role: "user",
          content: `---KNOWN WORKSPACE LISTING---\n${this._workspaceListing.result.slice(0, 1500)}\n\nThe workspace has already been listed. Do not call glob again. Read the relevant listed file or files now.`,
        });
        continue;
      }
      if (cachedInspection !== undefined) {
        this._cachedInspectionRedirects++;
        if (this._cachedInspectionRedirects >= 3) {
          const answer = cachedToolAnswer(tool, cachedInspection);
          this._messages.push({ role: "developer", content: answer });
          yield { type: "answer", content: answer };
          return;
        }
        this._messages.push({
          role: "user",
          content: `---CACHED TOOL RESULT: ${tool.name}---\n${cachedInspection.slice(0, 1500)}\n\nThis inspection already succeeded earlier. Use its evidence and take the next required action without calling the same tool again.`,
        });
        continue;
      }
      const repeatedSuccessfulCall = this._repeatedToolCalls > 1
        && this._lastToolResult !== null
        && !resultFailed(this._lastToolResult);
      if (repeatedSuccessfulCall) {
        if (this._repeatedToolCalls >= 3) {
          const answer = mutatesWorkspace(tool)
            ? this._evidenceAnswer("")
            : cachedToolAnswer(tool, this._lastToolResult);
          this._messages.push({ role: "developer", content: answer });
          yield { type: "answer", content: answer };
          return;
        }
        this._messages.push({
          role: "user",
          content: `---CACHED TOOL RESULT: ${tool.name}---\n${this._lastToolResult.slice(0, 1500)}\n\nThe identical inspection already succeeded. Use this result without calling the tool again.`,
        });
        continue;
      }
      if (this._repeatedToolCalls >= 3) {
        const detail = String(this._lastToolResult || "The operation did not complete.").slice(0, 1000);
        const answer = `The operation did not complete.\n${detail}`;
        this._messages.push({ role: "developer", content: answer });
        yield { type: "answer", content: answer };
        return;
      }
      if (this._plan && this._planIndex < this._plan.length && !auxiliaryTool) {
        this._plan[this._planIndex].status = "running";
        yield { type: "plan-update", index: this._planIndex, status: "running" };
      }
      yield { type: "tool-call", tool: tool.name, args: tool.args };

      let result;
      if (!t) {
        result = `Unknown tool "${tool.name}". Available: ${this._registry.list().map(x => x.name).join(", ")}`;
      } else {
        if (tool.name === "bash") {
          tool.args.workdir = this._workspace;
        }
        if (["read", "write", "edit", "analyze"].includes(tool.name) && tool.args?.path && !tool.args.path.startsWith("/")) {
          tool.args.path = resolve(this._workspace, tool.args.path);
        }
        if (["glob", "grep"].includes(tool.name) && tool.args?.path && !tool.args.path.startsWith("/")) {
          tool.args.path = resolve(this._workspace, tool.args.path);
        }
        if (["read", "write", "edit", "analyze", "glob", "grep", "task"].includes(tool.name)) {
          tool.args._agentWorkspace = this._workspace;
        }
        if (tool.name === "bash" && tool.args?.command) {
          const cmd = tool.args.command;
          if (/^npm\s+install\s+\S/.test(cmd) && !cmd.includes("--prefix")) {
            tool.args.command = cmd.replace(/^npm\s+install\s+/, "npm install --prefix . ");
          }
        }
        if (tool.name === "bash" && tool.args?.command) {
          const commandKey = String(tool.args.command).trim().replace(/\s+/g, " ");
          const isInspection = /^(?:ls|find|rg|grep)\b/i.test(commandKey);
          if (isInspection && this._inspectionCommands.has(commandKey)) {
            result = "BLOCKED: This inspection command already succeeded in the current request. Use the existing result instead of running it again.";
          }
          if (isInspection) this._inspectionCommands.add(commandKey);
        }
        if (tool.name === "write" && tool.args?.path) {
          const writePath = String(tool.args.path);
          const pathKey = String(tool.args.path);
          if (existsSync(writePath) && !this._lastToolIsRead && !this._autoReadDone.has(pathKey)) {
            const existing = readFileSync(writePath, "utf-8");
            this._messages.push({ role: "user", content: `---AUTO-READ: ${tool.args.path}---\n${existing.slice(0, 1500)}` });
            this._autoReadDone.add(pathKey);
          }
        }
        if (result === undefined) {
          try { result = await t.execute(tool.args); }
          catch (err) { result = `Error: ${err.message}`; }
        }
      }
      if (tool.name === "analyze" && !result.startsWith("Error:")) {
        this._lastAnalysis = result.slice(0, 1000);
      }
      yield { type: "tool-result", tool: tool.name, result };
      this._toolEvidence.push({
        tool: tool.name,
        args: { ...tool.args },
        result,
        failed: resultFailed(result),
      });
      this._rememberInspection(tool, result);
      if (!resultFailed(result) && mutatesWorkspace(tool)) this._invalidateInspectionCache();
      const contextualEvidence = tool.name === "bash" && isValidationCommand(tool.args?.command, this._taskContract.domain)
        ? ["validation"]
        : [];
      this._executionPolicy.record(tool.name, tool.args, result, resultFailed(result), contextualEvidence);
      this._lastToolResult = result;
      if (
        tool.name === "web"
        && !resultFailed(result)
        && (/^Registry:\s+https:\/\/registry\.npmjs\.org\//m.test(result) || /^Source: GitHub README fallback$/m.test(result))
      ) {
        this._resolvedArtifactDocumentation = true;
      }
      this._lastToolIsRead = ["read", "glob", "grep"].includes(tool.name);
      this._lastToolWasExecuted = true;
      if (tool.name === "write") this._totalWrites++;

      if (wantsFileCount(this._taskContract)) {
        const count = fileCountFromToolResult(tool, result);
        if (count !== null) {
          const answer = `There are ${count} files in ${this._workspace}.`;
          this._messages.push({ role: "developer", content: answer });
          yield { type: "answer", content: answer };
          return;
        }
      }

      // A no-op file mutation means the requested end state is already on
      // disk. Do not hand it back to the model, which can otherwise alternate
      // read/write/edit forever while trying to "finish" the same task.
      if (["write", "edit"].includes(tool.name) && result.startsWith("No changes to ")) {
        const answer = `Done — ${tool.args.path} already matches the requested change.`;
        this._messages.push({ role: "developer", content: answer });
        yield { type: "answer", content: answer };
        return;
      }

      if (tool.name === "bash" && result.startsWith("BLOCKED: Script ")) {
        this._messages.push({
          role: "user",
          content: "The requested local script does not exist. The user asked to create it, so call the write tool now with the complete source. Do not run the script again until write succeeds.",
        });
        continue;
      }

      if (["read", "glob", "grep"].includes(tool.name)) {
        const filePath = tool.args?.path || tool.args?.pattern || "";
        const count = (this._readFiles.get(filePath) || 0) + 1;
        this._readFiles.set(filePath, count);
        if (count >= 3) {
          this._messages.push({
            role: "user",
            content: `You have read "${filePath}" ${count} times already. Stop reading. You have enough information. Call a tool to ACT now — edit, write, or bash. If you need to modify a file, use write with the full new content.`,
          });
          this._readFiles.clear();
          continue;
        }
      } else {
        this._readFiles.clear();
      }

      if (this._plan && this._planIndex < this._plan.length && !auxiliaryTool) {
        const failed = result.startsWith("Error")
          || result.startsWith("Syntax validation")
          || /^Exit:\s*(?!0\b)-?\d+/m.test(result);
        const status = failed ? "failed" : "done";
        this._plan[this._planIndex].status = status;
        yield { type: "plan-update", index: this._planIndex, status };
        this._planNarrations = 0;

        if (!failed) {
          this._planIndex++;
          while (
            this._planIndex < this._plan.length
            && mutationSatisfiesPlanItem(tool, this._plan[this._planIndex].description)
          ) {
            this._plan[this._planIndex].status = "done";
            yield { type: "plan-update", index: this._planIndex, status: "done" };
            this._planIndex++;
          }
          if (tool.name === "websearch" && /^No relevant results found for domain /i.test(result)) {
            while (this._planIndex < this._plan.length && /\bfetch\b/i.test(this._plan[this._planIndex].description)) {
              this._plan[this._planIndex].status = "skipped";
              yield { type: "plan-update", index: this._planIndex, status: "skipped" };
              this._planIndex++;
            }
          }
        }
      }

      if (tool.name === "bash") {
        this._consecutiveBash++;
        if (this._consecutiveBash >= 3) {
          this._messages.push({
            role: "user",
            content: `STOP running bash commands. You have run ${this._consecutiveBash} in a row. You have enough information. Call the write tool now, or respond concisely. Do NOT run more bash commands.`,
          });
          this._consecutiveBash = 0;
          continue;
        }
        const cmd = String(tool.args?.command || "");
        const isRunCode = /^node\s+[^-]|^python[3]?\s+[^-]|^npm\s+start|^yarn\s+start|^pm2\s|^forever\s|^nodemon\s|^cargo\s+run|^mix\s+run/i.test(cmd);
        if (isRunCode && (result.includes("Timeout") || result.includes("Terminated") || /Exit:\s*-1/.test(result))) {
          yield { type: "stream", token: "All files are ready. To start the project, run in your terminal:\n\n```bash\ncd " + this._workspace + "\n" + cmd + "\n```" };
          yield { type: "stream-end" };
          return;
        }
        if (/^npm\s+install|^yarn\s+install|^pnpm\s+install/i.test(cmd) && !result.startsWith("Error")) {
          this._depsInstalled = true;
        }
      } else {
        this._consecutiveBash = 0;
      }

      if (["edit", "write"].includes(tool.name) && (result.startsWith("Syntax validation failed") || result.startsWith("Error: text not found"))) {
        const detail = result.startsWith("Syntax validation failed") ? result : "the provided oldString did not match any text in the file";
        this._messages.push({
          role: "user",
          content: `The requested fix was not applied:\n${detail}\n\nAnalyze the problem:\n1. Syntax error → fix the code, use write to rewrite the entire file\n2. Missing dependency detected in the result → install it with npm install/pip install\n3. Text not found → read the file first, then use write with the corrected content\nThe user already asked for a fix; do not ask for confirmation.`,
        });
        continue;
      }

      let verifyExtra = "";
      if (tool.name === "edit" && !result.startsWith("Error:") && !result.startsWith("No changes")) {
        const ext = tool.args?.path ? tool.args.path.split(".").pop().toLowerCase() : "";
        const verifyCmds = {
          py: `python3 -c "import ast; ast.parse(open('${tool.args.path}').read())"`,
          js: `node --check ${tool.args.path}`,
          mjs: `node --check ${tool.args.path}`,
          cjs: `node --check ${tool.args.path}`,
          json: `python3 -c "import json; json.load(open('${tool.args.path}'))"`,
        };
        const cmd = verifyCmds[ext];
        if (cmd) verifyExtra = `\n\nVerify the fix:\n  ${cmd}`;
      }
      const contextResultLimit = tool.name === "repo" ? 6000 : 1500;
      let msgContent = `---TOOL RESULT: ${tool.name}---\n${result.slice(0, contextResultLimit)}${result.length > contextResultLimit ? "\n...(truncated)" : ""}${verifyExtra}`;

      if (tool.name === "write" && tool.args?.path) {
        const writtenPath = String(tool.args.path);
        if (writtenPath.endsWith("package.json") && !result.startsWith("Error") && !result.startsWith("Syntax validation")) {
          const pkgDir = resolve(this._workspace, writtenPath.replace(/\/package\.json$/, "").replace(/^package\.json$/, "."));
          const nodeModulesPath = resolve(pkgDir, "node_modules");
          if (!existsSync(nodeModulesPath)) {
            yield { type: "tool-call", tool: "bash", args: { command: "npm install", workdir: pkgDir } };
            try {
              const installed = await execAsync("npm install", { cwd: pkgDir, timeoutMs: 60000 });
              this._depsInstalled = true;
              msgContent += "\n\n[auto] Dependencies installed automatically.";
              yield { type: "tool-result", tool: "bash", result: `Exit: 0\n${installed.stdout || "Dependencies installed."}` };
            } catch (e) {
              msgContent += "\n\n[auto] npm install failed — run it manually.";
              yield { type: "tool-result", tool: "bash", result: `Exit: -1\n${e.message}` };
            }
          } else {
            this._depsInstalled = true;
          }
        }
      }

      if (tool.name === "write") {
        this._consecutiveWrites++;
        if (this._consecutiveWrites >= 3) {
          this._messages.push({
            role: "user",
            content: `You have written ${this._consecutiveWrites} times in a row. STOP writing. Respond now with what was done and how to run it. Do NOT write any more files.`,
          });
          this._consecutiveWrites = 0;
        }
      } else {
        this._consecutiveWrites = 0;
      }
      this._messages.push({ role: "user", content: msgContent });
    }
    yield { type: "error", content: `Maximum tool turns (${this._config.maxTurns}) reached before completion.` };
  }
}
