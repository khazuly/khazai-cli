import { configRevision, readConfigFile, updateConfigFile } from "./store.js";
import { canonicalModelKey } from "./khazai-free-models.js";
import {
  AUTO_FREE_SECTIONS,
  GLOBAL_DEFAULTS,
  SETTING_SECTIONS,
  providerDefaults,
  resolveProviderCapabilities,
  resolveProviderId,
} from "./model-setting-schema.js";
export {
  AUTO_FREE_SECTIONS,
  GLOBAL_DEFAULTS,
  SETTING_SECTIONS,
  providerDefaults,
  providerIdFromModel,
  resolveProviderCapabilities,
} from "./model-setting-schema.js";

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
  emergencyCompactionThreshold(value) {
    const n = positiveFloat(value);
    if (n === null) return { valid: false, message: "Emergency compaction threshold must be a number." };
    if (n <= 0 || n > 1) return { valid: false, message: "Emergency compaction threshold must be greater than 0 and at most 1." };
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
    case "emergencyCompactionThreshold": return VALIDATORS.emergencyCompactionThreshold(value);
    case "requestTimeoutMs": return VALIDATORS.defaultInt(value, null, 5_000, 600_000);
    case "toolTimeoutMs": return VALIDATORS.defaultInt(value, null, 1_000, 300_000);
    case "maxProviderRetries": return VALIDATORS.defaultInt(value, null, 0, 10);
    case "planningDepth": return VALIDATORS.defaultInt(value, null, 0, 10);
    case "maxAgentIterations": return VALIDATORS.defaultInt(value, null, 1, 500);
    case "maxConsecutiveToolCalls": return VALIDATORS.defaultInt(value, null, 1, 100);
    case "maxToolsPerIteration": return VALIDATORS.defaultInt(value, null, 1, 50);
    case "maxCompactedSummarySize": return VALIDATORS.defaultInt(value, null, 128, 16_384);
    case "preserveRecentTurns": return VALIDATORS.defaultInt(value, null, 0, 50);
    case "reservedOutputHeadroom": return VALIDATORS.defaultInt(value, null, 0, 1_048_576);
    case "compactionSoftLimit": return VALIDATORS.defaultInt(value, null, 2_000, 1_048_576);
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
  return config.modelSettings?.[canonicalModelKey(model)] || {};
}

export function saveModelSettings(model, settings) {
  if (!model) return;
  const canonical = canonicalModelKey(model);
  if (settings.contextLimit !== undefined && settings.contextLimit !== null) {
    const validation = validateSetting("contextLimit", settings.contextLimit, canonical);
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
      [canonical]: cleaned,
    },
  }), { reason: `model-settings:${canonical}` });
}

export function resetModelSettings(model, section) {
  if (!model) return;
  const canonical = canonicalModelKey(model);
  updateConfigFile(config => {
    const modelSettings = { ...(config.modelSettings || {}) };
    if (section) {
      const sectionDef = SETTING_SECTIONS[section] || AUTO_FREE_SECTIONS[section];
      if (!sectionDef) return config;
      const current = { ...(modelSettings[canonical] || {}) };
      for (const setting of sectionDef.settings) delete current[setting.key];
      modelSettings[canonical] = current;
    } else {
      delete modelSettings[canonical];
    }
    return { ...config, modelSettings };
  }, { reason: `model-settings:${canonical}` });
}

function contextMetadata(model, config, providerMetadata) {
  const requested = canonicalModelKey(model);
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
  const canonical = canonicalModelKey(model);
  const modelDefaults = persisted?.modelSettings?.[canonical] || {};
  const pv = providerDefaults(resolveProviderId(canonical));
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
    || strictPositiveInt(persisted?.models?.[canonical]?.contextLimit);
  const providerLimit = contextMetadata(canonical, persisted, providerMetadata);
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
  const reservedHeadroom = sessionOverrides.reservedOutputHeadroom
    ?? modelDefaults.reservedOutputHeadroom
    ?? persisted?.reservedOutputHeadroom;
  result.reservedOutputHeadroom = Number.isFinite(Number(reservedHeadroom)) && Number(reservedHeadroom) > 0
    ? Math.floor(Number(reservedHeadroom))
    : null;
  const softLimit = sessionOverrides.compactionSoftLimit
    ?? modelDefaults.compactionSoftLimit
    ?? persisted?.compactionSoftLimit
    ?? GLOBAL_DEFAULTS.compactionSoftLimit;
  result.compactionSoftLimit = Number.isFinite(Number(softLimit)) && Number(softLimit) > 0
    ? Math.floor(Number(softLimit))
    : null;
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

export function migrateModelSettings(config = {}) {
  const migrated = { ...config };
  const canonicalKey = key => canonicalModelKey(key, migrated);

  const modelSettings = {};
  for (const [key, value] of Object.entries(config.modelSettings || {})) {
    const canonical = canonicalKey(key);
    modelSettings[canonical] = { ...(modelSettings[canonical] || {}), ...(value || {}) };
  }
  migrated.modelSettings = modelSettings;

  const models = {};
  for (const [key, value] of Object.entries(config.models || {})) {
    const canonical = canonicalKey(key);
    models[canonical] = { ...(models[canonical] || {}), ...(value || {}) };
  }
  migrated.models = models;

  if (config.model) migrated.model = canonicalKey(config.model);
  return migrated;
}
