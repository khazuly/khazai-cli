import { resolveZenModel } from "./khazai-free-models.js";
import { findQwenCloudModel } from "../lib/qwen-cloud.js";

const PROVIDER_CAPABILITIES = {
  "khazai-free": {
    supportsTemperature: true,
    supportsTopP: true,
    supportsMaxTokens: true,
    supportsStreaming: true,
    supportsReasoningEffort: false,
    supportsParallelTools: true,
    supportsToolCalling: true,
    supportsToolChoice: false,
    supportsStreamOptions: false,
    outputLimit: 32_000,
    temperatureRange: [0, 2],
    topPRange: [0, 1],
  },
  opencode: {
    supportsTemperature: true,
    supportsTopP: true,
    supportsMaxTokens: true,
    supportsStreaming: true,
    supportsReasoningEffort: false,
    supportsParallelTools: true,
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
    supportsParallelTools: true,
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
    supportsParallelTools: true,
    supportsToolCalling: true,
    supportsToolChoice: true,
    supportsStreamOptions: false,
    outputLimit: 4_096,
    temperatureRange: [0, 2],
    topPRange: [0, 1],
  },
  "gemini-guest": {
    supportsTemperature: false,
    supportsTopP: false,
    supportsMaxTokens: false,
    supportsStreaming: false,
    supportsReasoningEffort: false,
    supportsParallelTools: true,
    supportsToolCalling: true,
    supportsToolChoice: false,
    supportsStreamOptions: false,
    outputLimit: 8_192,
    temperatureRange: [0, 2],
    topPRange: [0, 1],
  },
  mistral: {
    supportsTemperature: true,
    supportsTopP: true,
    supportsMaxTokens: true,
    supportsStreaming: true,
    supportsReasoningEffort: false,
    supportsParallelTools: true,
    supportsToolCalling: true,
    supportsToolChoice: false,
    supportsStreamOptions: false,
    outputLimit: 32_000,
    temperatureRange: [0, 2],
    topPRange: [0, 1],
  },
  aichat: {
    supportsTemperature: false,
    supportsTopP: false,
    supportsMaxTokens: false,
    supportsStreaming: true,
    supportsReasoningEffort: false,
    supportsParallelTools: true,
    supportsToolCalling: true,
    supportsToolChoice: false,
    supportsStreamOptions: false,
    outputLimit: null,
    temperatureRange: [0, 2],
    topPRange: [0, 1],
  },
  "qwen-cloud": {
    supportsTemperature: true,
    supportsTopP: true,
    supportsMaxTokens: true,
    supportsStreaming: true,
    supportsReasoningEffort: false,
    supportsParallelTools: true,
    supportsToolCalling: true,
    supportsToolChoice: true,
    supportsStreamOptions: true,
    outputLimit: null,
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

export function resolveProviderId(model) {
  if (!model) return "opencode";
  const lower = String(model).toLowerCase();
  if (["big-cock", "cock"].includes(lower)) return "opencode";
  if (lower === "auto-free") return "auto-free";
  if (lower.startsWith("codex/")) return "codex";
  if (lower === "vibe" || lower === "mistral/vibe") return "mistral";
  if (["gemini-guest", "gemini/3.5-flash-lite", "3.5-flash-lite"].includes(lower)) return "gemini-guest";
  if (lower === "aichat/claude-haiku-4-5") return "aichat";
  if (findQwenCloudModel(lower)) return "qwen-cloud";
  const zen = resolveZenModel(lower);
  if (zen) return zen.alias === "big-cock" ? "opencode" : "khazai-free";
  if (lower.startsWith("khazai-free/")) return "khazai-free";
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
  compactionThreshold: 1,
  emergencyCompactionThreshold: 1,
  compactionSoftLimit: null,
  preserveRecentTurns: 2,
  maxCompactedSummarySize: 4_096,
  reservedOutputHeadroom: null,

  requestTimeoutMs: 300_000,
  toolTimeoutMs: 60_000,
  maxProviderRetries: 3,
  retryBackoff: "exponential",
  autoFallback: false,
  prematureStreamRetry: true,
  invalidToolCallRetry: true,

  toolCallingEnabled: true,
  parallelToolCalls: true,
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
  if (providerId === "codex") {
    return {
      maxProviderRetries: 3,
      requestTimeoutMs: 300_000,
    };
  }
  if (providerId === "opencode") {
    return {
      maxOutputTokens: 32_000,
      requestTimeoutMs: 120_000,
    };
  }
  if (providerId === "khazai-free") {
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
      { key: "emergencyCompactionThreshold", label: "Emergency compaction threshold", type: "float", min: 0.01, max: 1, step: 0.05 },
      { key: "compactionSoftLimit", label: "Compaction soft token limit", type: "int", min: 2_000, max: 1_048_576 },
      { key: "preserveRecentTurns", label: "Preserve recent turns", type: "int", min: 0, max: 50 },
      { key: "maxCompactedSummarySize", label: "Maximum compacted-summary size", type: "int", min: 128, max: 16_384 },
      { key: "reservedOutputHeadroom", label: "Reserved output headroom", type: "int", min: 0, max: 1_048_576 },
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
