import {
  configRevision,
  readConfigFile,
  updateConfigFile,
} from "./store.js";

const PROVIDER_CAPABILITIES = {
  opencode: {
    supportsTemperature: true,
    supportsTopP: true,
    supportsMaxTokens: true,
    supportsStreaming: true,
    supportsReasoningEffort: false,
    supportsParallelTools: false,
    supportsToolCalling: true,
    supportsToolChoice: false,
    supportsStreamOptions: true,
    outputLimit: 128_000,
    temperatureRange: [0, 2],
    topPRange: [0, 1],
  },
  codex: {
    supportsTemperature: false,
    supportsTopP: false,
    supportsMaxTokens: false,
    supportsStreaming: true,
    supportsReasoningEffort: true,
    supportsParallelTools: false,
    supportsToolCalling: true,
    supportsToolChoice: true,
    supportsStreamOptions: false,
    outputLimit: 16_384,
    temperatureRange: [0, 2],
    topPRange: [0, 1],
  },
  "auto-free": {
    supportsTemperature: true,
    supportsTopP: false,
    supportsMaxTokens: true,
    supportsStreaming: true,
    supportsReasoningEffort: false,
    supportsParallelTools: false,
    supportsToolCalling: true,
    supportsToolChoice: true,
    supportsStreamOptions: false,
    outputLimit: 4_096,
    temperatureRange: [0, 2],
    topPRange: [0, 1],
  },
};

const DEFAULT_CAPABILITIES = {
  supportsTemperature: true,
  supportsTopP: true,
  supportsMaxTokens: true,
  supportsStreaming: true,
  supportsReasoningEffort: false,
  supportsParallelTools: false,
  supportsToolCalling: true,
  supportsToolChoice: true,
  supportsStreamOptions: false,
  outputLimit: null,
  temperatureRange: [0, 2],
  topPRange: [0, 1],
};

function resolveProviderId(model) {
  if (!model) return "opencode";
  const lower = String(model).toLowerCase();
  if (["big-cock", "cock"].includes(lower)) return "opencode";
  if (lower === "auto-free") return "auto-free";
  if (lower.startsWith("codex/")) return "codex";
  const separator = lower.indexOf("/");
  if (separator > 0) return lower.slice(0, separator);
  return "opencode";
}

export function providerIdFromModel(model) {
  return resolveProviderId(model);
}

export function resolveProviderCapabilities(model, definition = {}) {
  const base = PROVIDER_CAPABILITIES[resolveProviderId(model)] || DEFAULT_CAPABILITIES;
  const configured = definition.capabilities || {};
  return {
    ...base,
    ...configured,
    ...(configured.streaming !== undefined ? { supportsStreaming: Boolean(configured.streaming) } : {}),
    ...(configured.tools !== undefined ? { supportsToolCalling: Boolean(configured.tools) } : {}),
    ...(configured.parallelTools !== undefined
      ? { supportsParallelTools: Boolean(configured.parallelTools) }
      : {}),
  };
}

export const GLOBAL_DEFAULTS = {
  temperature: 0.7,
  topP: 1.0,
  maxOutputTokens: 32_000,
  responseVerbosity: "normal",
  streamingEnabled: true,

  reasoningEffort: "medium",
  planningDepth: 1,
  maxAgentIterations: 200,
  maxConsecutiveToolCalls: 25,

  contextLimit: null,
  automaticCompaction: true,
  compactionThreshold: 0.9,
  preserveRecentTurns: 5,
  maxCompactedSummarySize: 2_048,

  requestTimeoutMs: 300_000,
  toolTimeoutMs: 60_000,
  maxProviderRetries: 3,
  retryBackoff: "exponential",
  autoFallback: false,
  prematureStreamRetry: true,
  invalidToolCallRetry: true,

  toolCallingEnabled: true,
  parallelToolCalls: false,
  maxToolsPerIteration: 8,
  toolResultPreviewSize: 2_000,
  duplicateToolProtection: true,

  routingStrategy: "latency",
  fallbackEnabled: true,
  maxModelAttempts: 3,
  preferToolCapableModels: true,
  preferModelsWithContextLimits: true,
  skipUnhealthyRoutes: true,
};

export function providerDefaults(providerId) {
  if (providerId === "auto-free") {
    return {
      maxOutputTokens: 4_096,
      requestTimeoutMs: 120_000,
      maxProviderRetries: 1,
      maxAgentIterations: 50,
    };
  }
  if (providerId === "opencode") {
    return {
      maxOutputTokens: 32_000,
      requestTimeoutMs: 120_000,
    };
  }
  return {};
}

export const SETTING_SECTIONS = {
  generation: {
    label: "Generation",
    settings: [
      { key: "temperature", label: "Temperature", type: "float", min: 0, max: 2, step: 0.1 },
      { key: "topP", label: "Top P", type: "float", min: 0, max: 1, step: 0.05 },
      { key: "maxOutputTokens", label: "Maximum output tokens", type: "int", min: 1, max: 128_000 },
      { key: "responseVerbosity", label: "Response verbosity", type: "select", options: ["concise", "normal", "verbose"] },
      { key: "streamingEnabled", label: "Streaming enabled", type: "boolean" },
    ],
  },
  reasoning: {
    label: "Reasoning",
    settings: [
      { key: "reasoningEffort", label: "Reasoning effort", type: "select", options: ["low", "medium", "high", "provider default"] },
      { key: "planningDepth", label: "Planning depth", type: "int", min: 0, max: 10 },
      { key: "maxAgentIterations", label: "Maximum agent iterations", type: "int", min: 1, max: 500 },
      { key: "maxConsecutiveToolCalls", label: "Maximum consecutive tool calls", type: "int", min: 1, max: 100 },
    ],
  },
  context: {
    label: "Context",
    settings: [
      { key: "contextLimit", label: "Context limit override", type: "context-limit" },
      { key: "automaticCompaction", label: "Automatic compaction enabled", type: "boolean" },
      { key: "compactionThreshold", label: "Compaction threshold", type: "float", min: 0.01, max: 1, step: 0.05 },
      { key: "preserveRecentTurns", label: "Preserve recent turns", type: "int", min: 0, max: 50 },
      { key: "maxCompactedSummarySize", label: "Maximum compacted-summary size", type: "int", min: 128, max: 16_384 },
    ],
  },
  reliability: {
    label: "Reliability",
    settings: [
      { key: "requestTimeoutMs", label: "Request timeout (ms)", type: "int", min: 5_000, max: 600_000 },
      { key: "toolTimeoutMs", label: "Tool timeout (ms)", type: "int", min: 1_000, max: 300_000 },
      { key: "maxProviderRetries", label: "Maximum provider retries", type: "int", min: 0, max: 10 },
      { key: "retryBackoff", label: "Retry backoff", type: "select", options: ["linear", "exponential"] },
      { key: "autoFallback", label: "Auto fallback", type: "boolean" },
      { key: "prematureStreamRetry", label: "Premature stream retry", type: "boolean" },
      { key: "invalidToolCallRetry", label: "Invalid tool-call retry", type: "boolean" },
    ],
  },
  tools: {
    label: "Tool usage",
    settings: [
      { key: "toolCallingEnabled", label: "Tool calling enabled", type: "boolean" },
      { key: "parallelToolCalls", label: "Parallel tool calls", type: "boolean" },
      { key: "maxToolsPerIteration", label: "Maximum tools per iteration", type: "int", min: 1, max: 50 },
      { key: "toolResultPreviewSize", label: "Tool-result preview size", type: "int", min: 0, max: 50_000 },
      { key: "duplicateToolProtection", label: "Duplicate-tool protection", type: "boolean" },
    ],
  },
};

export const AUTO_FREE_SECTIONS = {
  routing: {
    label: "Routing",
    settings: [
      { key: "routingStrategy", label: "Routing strategy", type: "select", options: ["latency", "random", "round-robin"] },
      { key: "fallbackEnabled", label: "Fallback enabled", type: "boolean" },
      { key: "maxModelAttempts", label: "Maximum model attempts", type: "int", min: 1, max: 10 },
      { key: "preferToolCapableModels", label: "Prefer tool-capable models", type: "boolean" },
      { key: "preferModelsWithContextLimits", label: "Prefer models with known context limits", type: "boolean" },
      { key: "skipUnhealthyRoutes", label: "Temporarily skip unhealthy routes", type: "boolean" },
    ],
  },
};

function positiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && Number.isInteger(n) ? n : null;
}

function strictPositiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && Number.isInteger(n) ? n : null;
}

function positiveFloat(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const VALIDATORS = {
  temperature(value, caps) {
    const n = positiveFloat(value);
    if (n === null) return { valid: false, message: "Temperature must be a number." };
    const [min, max] = caps.temperatureRange || [0, 2];
    if (n < min || n > max) return { valid: false, message: `Temperature must be between ${min} and ${max}.` };
    return { valid: true, value: Math.round(n * 100) / 100 };
  },
  topP(value, caps) {
    const n = positiveFloat(value);
    if (n === null) return { valid: false, message: "Top P must be a number." };
    if (n < 0 || n > 1) return { valid: false, message: "Top P must be between 0 and 1." };
    return { valid: true, value: Math.round(n * 100) / 100 };
  },
  maxOutputTokens(value, caps) {
    const n = positiveInt(value);
    if (n === null) return { valid: false, message: "Maximum output tokens must be a positive integer." };
    const max = caps.outputLimit || 128_000;
    if (n > max) return { valid: false, message: `Maximum output tokens cannot exceed ${max.toLocaleString()}.` };
    return { valid: true, value: n };
  },
  contextLimit(value) {
    if (value === null || value === "provider" || value === "") return { valid: true, value: null };
    const n = strictPositiveInt(value);
    if (n === null) return { valid: false, message: "Context limit must be a positive integer or null." };
    return { valid: true, value: n };
  },
  compactionThreshold(value) {
    const n = positiveFloat(value);
    if (n === null) return { valid: false, message: "Compaction threshold must be a number." };
    if (n <= 0 || n > 1) return { valid: false, message: "Compaction threshold must be greater than 0 and at most 1." };
    return { valid: true, value: Math.round(n * 100) / 100 };
  },
  defaultInt(value, def, min, max) {
    const n = positiveInt(value);
    if (n === null) return { valid: false, message: `Must be a positive integer.` };
    if (min !== undefined && n < min) return { valid: false, message: `Minimum value is ${min}.` };
    if (max !== undefined && n > max) return { valid: false, message: `Maximum value is ${max}.` };
    return { valid: true, value: n };
  },
};

export function validateSetting(key, value, model) {
  const caps = resolveProviderCapabilities(model);
  switch (key) {
    case "temperature": return VALIDATORS.temperature(value, caps);
    case "topP": return VALIDATORS.topP(value, caps);
    case "maxOutputTokens": return VALIDATORS.maxOutputTokens(value, caps);
    case "contextLimit": return VALIDATORS.contextLimit(value);
    case "compactionThreshold": return VALIDATORS.compactionThreshold(value);
    case "requestTimeoutMs": return VALIDATORS.defaultInt(value, null, 5_000, 600_000);
    case "toolTimeoutMs": return VALIDATORS.defaultInt(value, null, 1_000, 300_000);
    case "maxProviderRetries": return VALIDATORS.defaultInt(value, null, 0, 10);
    case "planningDepth": return VALIDATORS.defaultInt(value, null, 0, 10);
    case "maxAgentIterations": return VALIDATORS.defaultInt(value, null, 1, 500);
    case "maxConsecutiveToolCalls": return VALIDATORS.defaultInt(value, null, 1, 100);
    case "maxToolsPerIteration": return VALIDATORS.defaultInt(value, null, 1, 50);
    case "maxCompactedSummarySize": return VALIDATORS.defaultInt(value, null, 128, 16_384);
    case "preserveRecentTurns": return VALIDATORS.defaultInt(value, null, 0, 50);
    case "toolResultPreviewSize": return VALIDATORS.defaultInt(value, null, 0, 50_000);
    case "maxModelAttempts": return VALIDATORS.defaultInt(value, null, 1, 10);
    default:
      if (typeof value === "boolean") return { valid: true, value };
      if (typeof value === "string" && value) return { valid: true, value };
      return { valid: false, message: `Invalid value for ${key}.` };
  }
}

export function settingIsSupported(key, model) {
  const caps = resolveProviderCapabilities(model);
  switch (key) {
    case "temperature": return caps.supportsTemperature;
    case "topP": return caps.supportsTopP;
    case "maxOutputTokens": return caps.supportsMaxTokens;
    case "streamingEnabled": return caps.supportsStreaming;
    case "reasoningEffort": return caps.supportsReasoningEffort;
    case "parallelToolCalls":
    case "maxToolsPerIteration": return caps.supportsParallelTools;
    default: return true;
  }
}

export function settingIsReadOnly(key) {
  return false;
}

export function settingIsAutoFreeOnly(key) {
  return ["routingStrategy", "fallbackEnabled", "maxModelAttempts",
    "preferToolCapableModels", "preferModelsWithContextLimits",
    "skipUnhealthyRoutes"].includes(key);
}

export function loadModelSettings(model) {
  if (!model) return {};
  const config = readConfigFile();
  return config.modelSettings?.[model] || {};
}

export function saveModelSettings(model, settings) {
  if (!model) return;
  if (settings.contextLimit !== undefined && settings.contextLimit !== null) {
    const validation = validateSetting("contextLimit", settings.contextLimit, model);
    if (!validation.valid) throw new Error(validation.message);
  }
  const cleaned = {};
  for (const [key, value] of Object.entries(settings)) {
    if (value !== undefined && value !== null) {
      cleaned[key] = value;
    }
  }
  updateConfigFile(config => ({
    ...config,
    modelSettings: {
      ...(config.modelSettings || {}),
      [model]: cleaned,
    },
  }), { reason: `model-settings:${model}` });
}

export function resetModelSettings(model, section) {
  if (!model) return;
  updateConfigFile(config => {
    const modelSettings = { ...(config.modelSettings || {}) };
    if (section) {
      const sectionDef = SETTING_SECTIONS[section] || AUTO_FREE_SECTIONS[section];
      if (!sectionDef) return config;
      const current = { ...(modelSettings[model] || {}) };
      for (const setting of sectionDef.settings) delete current[setting.key];
      modelSettings[model] = current;
    } else {
      delete modelSettings[model];
    }
    return { ...config, modelSettings };
  }, { reason: `model-settings:${model}` });
}

function contextMetadata(model, config, providerMetadata) {
  const requested = String(model || "");
  const providerId = resolveProviderId(requested);
  const modelId = requested.includes("/") ? requested.slice(requested.indexOf("/") + 1) : requested;
  const exactId = providerId === "opencode" && ["big-cock", "cock"].includes(requested.toLowerCase())
    ? "opencode/big-pickle"
    : requested;
  const metadata = providerMetadata?.contextLimit
    ?? config?.modelMetadata?.[exactId]?.contextLimit
    ?? config?.modelMetadata?.[requested]?.contextLimit
    ?? config?.providers?.[providerId]?.contextLimits?.[modelId]
    ?? config?.providers?.[providerId]?.contextLimit;
  return strictPositiveInt(metadata);
}

export function resolveEffectiveSettings(model, {
  sessionOverrides = {},
  config,
  providerMetadata = {},
} = {}) {
  const persisted = config === undefined ? readConfigFile() : config;
  const modelDefaults = persisted?.modelSettings?.[model] || {};
  const pv = providerDefaults(resolveProviderId(model));
  const result = { ...GLOBAL_DEFAULTS };

  for (const [key, value] of Object.entries(pv)) {
    if (value !== undefined) result[key] = value;
  }

  for (const [key, value] of Object.entries(modelDefaults)) {
    if (value !== undefined) result[key] = value;
  }

  for (const [key, value] of Object.entries(sessionOverrides)) {
    if (value !== undefined) result[key] = value;
  }
  if (
    sessionOverrides.compactionThreshold === undefined
    && modelDefaults.compactionThreshold === undefined
    && persisted?.compactThreshold !== undefined
  ) {
    result.compactionThreshold = persisted.compactThreshold;
  }

  const sessionLimit = strictPositiveInt(sessionOverrides.contextLimit);
  const modelLimit = strictPositiveInt(modelDefaults.contextLimit)
    || strictPositiveInt(persisted?.models?.[model]?.contextLimit);
  const providerLimit = contextMetadata(model, persisted, providerMetadata);
  const applicationLimit = strictPositiveInt(persisted?.contextLimit)
    || strictPositiveInt(GLOBAL_DEFAULTS.contextLimit);
  result.contextLimit = sessionLimit || modelLimit || providerLimit || applicationLimit || null;
  result.contextLimitSource = sessionLimit
    ? "session"
    : modelLimit
      ? "config"
      : providerLimit
        ? "provider"
        : applicationLimit
          ? "config"
          : "unknown";
  result.settingsRevision = configRevision();
  return result;
}

export function resolveEffectiveSetting(model, key, options = {}) {
  return resolveEffectiveSettings(model, options)[key];
}

export function formatSettingValue(key, value, model) {
  if (value === null || value === undefined) return "Not set";

  if (value === "provider default") return "Provider default";
  if (typeof value === "boolean") return value ? "Yes" : "No";

  switch (key) {
    case "requestTimeoutMs":
    case "toolTimeoutMs":
      return `${(value / 1000).toFixed(0)}s`;
    case "contextLimit":
      if (value === null) return "Provider metadata";
      if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
      if (value >= 1_000) return `${(value / 1_000).toLocaleString()}k`;
      return String(value);
    case "temperature":
    case "topP":
      return Number(value).toFixed(2);
    default:
      if (typeof value === "number") return value.toLocaleString();
      if (typeof value === "string") return value.charAt(0).toUpperCase() + value.slice(1);
      return String(value);
  }
}

export function suggestedContextLimits() {
  return [null, 32_000, 64_000, 128_000];
}

export function suggestedTemperatureValues() {
  return [0, 0.2, 0.7, 1.0, "custom", "provider default"];
}

export function isRecommendedValue(key, value) {
  if (key === "temperature" && value === 0.7) return true;
  if (key === "topP" && value === 1.0) return true;
  return false;
}
