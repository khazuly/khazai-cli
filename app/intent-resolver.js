import { chat } from "../lib/llm.js";

export const INTENTS = new Set(["answer", "inspect", "change", "validate", "delete", "research", "unknown"]);
export const OPERATIONS = new Set([
  "answer",
  "list_files",
  "count_files",
  "inspect_code",
  "discover_endpoints",
  "research",
  "create",
  "modify",
  "install",
  "git",
  "validate",
  "delete",
  "clear_workspace",
]);
export const EVIDENCE = new Set(["inspection", "research", "mutation", "deletion", "validation"]);
export const CONTINUATIONS = new Set(["standalone", "refine_existing", "accept_offer"]);
export const DOMAINS = new Set(["general", "obfuscation", "web", "git", "package"]);

const ENGLISH_ACTIONS = {
  change: /\b(?:create|build|implement|write|edit|fix|add|install|update|refactor|convert|generate|rename|move|copy|commit|push|publish|deploy)\b/i,
  delete: /\b(?:delete|remove|clear|unlink)\b/i,
  inspect: /\b(?:inspect|read|list|check|review|audit|analy[sz]e|explain|search|find|fetch|discover)\b/i,
  validate: /\b(?:test|testing|verify|validate|lint|typecheck|run|execute|runnable)\b/i,
  research: /https?:\/\/|\b(?:website|web|url|endpoint|documentation|docs|npm|github)\b/i,
};

function defaultEvidence(intent) {
  if (intent === "change") return ["mutation"];
  if (intent === "delete") return ["deletion"];
  if (intent === "validate") return ["validation"];
  if (intent === "research") return ["research"];
  if (intent === "inspect") return ["inspection"];
  return [];
}

function fallbackOperation(intent, input) {
  if (intent === "delete") return /\b(?:all|everything|workspace|directory contents)\b/i.test(input) ? "clear_workspace" : "delete";
  if (intent === "validate") return "validate";
  if (intent === "research") return /\b(?:endpoint|bundle|source map|route)\b/i.test(input) ? "discover_endpoints" : "research";
  if (intent === "change") return /\binstall\b/i.test(input) ? "install" : /\b(?:commit|push)\b/i.test(input) ? "git" : "modify";
  if (intent === "inspect") {
    if (/\b(?:how many|count|total)\b[\s\S]{0,30}\bfiles?\b/i.test(input)) return "count_files";
    if (/\b(?:list|show|find)\b[\s\S]{0,30}\bfiles?\b/i.test(input)) return "list_files";
    return "inspect_code";
  }
  return "answer";
}

export function fallbackIntentContract(input) {
  const text = String(input || "").trim();
  const deleteIntent = ENGLISH_ACTIONS.delete.test(text);
  const negatedChange = /\b(?:do not|don't|without)\s+(?:create|write|edit|change|modify|update|delete|remove)\b/i.test(text);
  const changeIntent = !deleteIntent && !negatedChange && ENGLISH_ACTIONS.change.test(text);
  const validateIntent = !changeIntent && ENGLISH_ACTIONS.validate.test(text);
  const researchIntent = !changeIntent && ENGLISH_ACTIONS.research.test(text) && ENGLISH_ACTIONS.inspect.test(text);
  const inspectIntent = !changeIntent && ENGLISH_ACTIONS.inspect.test(text);
  const intent = deleteIntent
    ? "delete"
    : changeIntent
      ? "change"
      : validateIntent
        ? "validate"
        : researchIntent
          ? "research"
          : inspectIntent
            ? "inspect"
            : "unknown";
  const requestedExtensions = [...new Set((text.match(/\.(?:py|js|mjs|cjs|ts|tsx|html|css|json|md|sh)\b/gi) || []).map(value => value.toLowerCase()))];
  const validationRequested = ENGLISH_ACTIONS.validate.test(text);
  const requiredEvidence = defaultEvidence(intent);
  if (intent === "change" && validationRequested) requiredEvidence.push("validation");
  return normalizeIntentContract({
    intent,
    operation: fallbackOperation(intent, text),
    continuation: "standalone",
    requiresPlan: text.length >= 180,
    requiredEvidence,
    requestedExtensions,
    modifiesFiles: intent === "change" && !/\b(?:install|commit|push|deploy)\b/i.test(text),
    validationRequested,
    allowMutationBeforeFailure: intent === "change",
    repairExistingOnFailure: intent === "validate",
    createNewFiles: intent === "change",
    targetUrl: /https?:\/\/[^\s<>'"`)\]]+/i.exec(text)?.[0] || "",
    domain: /obfuscat|encrypt/i.test(text) ? "obfuscation" : "general",
  }, text);
}

export function normalizeIntentContract(value, input = "") {
  const source = value && typeof value === "object" ? value : {};
  const intent = INTENTS.has(source.intent) ? source.intent : "unknown";
  const operation = OPERATIONS.has(source.operation) ? source.operation : fallbackOperation(intent, String(input));
  const suppliedEvidence = Array.isArray(source.requiredEvidence)
    ? [...new Set(source.requiredEvidence.filter(item => EVIDENCE.has(item)))]
    : defaultEvidence(intent);
  const requiredEvidence = [...new Set([...defaultEvidence(intent), ...suppliedEvidence])];
  return {
    request: String(input || ""),
    intent,
    operation,
    continuation: CONTINUATIONS.has(source.continuation) ? source.continuation : "standalone",
    requiresPlan: Boolean(source.requiresPlan),
    requiredEvidence,
    requestedExtensions: Array.isArray(source.requestedExtensions)
      ? [...new Set(source.requestedExtensions.filter(item => /^\.[a-z0-9]+$/i.test(item)).map(item => item.toLowerCase()))]
      : [],
    modifiesFiles: intent === "change" && Boolean(source.modifiesFiles),
    validationRequested: intent === "validate" || Boolean(source.validationRequested),
    allowMutationBeforeFailure: intent === "change" && Boolean(source.allowMutationBeforeFailure),
    repairExistingOnFailure: intent === "validate" && Boolean(source.repairExistingOnFailure),
    createNewFiles: intent === "change" && Boolean(source.createNewFiles),
    targetUrl: typeof source.targetUrl === "string" ? source.targetUrl : "",
    domain: DOMAINS.has(source.domain) ? source.domain : "general",
    uncertain: intent === "unknown",
  };
}

function parseContract(text, input) {
  const source = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return normalizeIntentContract(JSON.parse(source.slice(start, end + 1)), input);
  } catch {
    return null;
  }
}

function classifierPrompt({ input, previousRequest = "", previousAssistant = "" }) {
  return [
    "Classify the user's current coding-agent request by meaning, regardless of its language.",
    "Return exactly one JSON object and no prose.",
    "Use only these values:",
    "intent: answer | inspect | change | validate | delete | research | unknown",
    "operation: answer | list_files | count_files | inspect_code | discover_endpoints | research | create | modify | install | git | validate | delete | clear_workspace",
    "continuation: standalone | refine_existing | accept_offer",
    "requiredEvidence items: inspection | research | mutation | deletion | validation",
    "domain: general | obfuscation | web | git | package",
    "Schema:",
    '{"intent":"...","operation":"...","continuation":"...","requiresPlan":false,"requiredEvidence":[],"requestedExtensions":[],"modifiesFiles":false,"validationRequested":false,"allowMutationBeforeFailure":false,"repairExistingOnFailure":false,"createNewFiles":false,"targetUrl":"","domain":"general"}',
    "A request to run or test an existing artifact is validate, not change. It must not create files before an observed failure.",
    "A requirement that newly implemented output must be runnable is change with validationRequested=true and requires mutation plus validation evidence.",
    "If the current message accepts an implementation offered in the previous assistant response, use accept_offer.",
    "If it modifies requirements of the previous implementation, use refine_existing.",
    "Current user message:",
    String(input),
    "Previous user request:",
    String(previousRequest).slice(0, 1200),
    "Previous assistant response:",
    String(previousAssistant).slice(0, 1200),
  ].join("\n");
}

export class IntentResolver {
  constructor({ classify = chat } = {}) {
    this._classify = classify;
  }

  async resolve(context) {
    try {
      const response = await this._classify(
        [{ role: "user", content: classifierPrompt(context) }],
        { model: context.model, signal: context.signal, maxTokens: 700 },
      );
      return parseContract(response, context.input) || fallbackIntentContract(context.input);
    } catch {
      return fallbackIntentContract(context.input);
    }
  }
}
