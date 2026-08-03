export const KHAZAI_FREE_UPSTREAM_BASE_URL = "https://opencode.ai/zen/v1";
export const KHAZAI_FREE_PROVIDER_ID = "khazai-free";
export const KHAZAI_FREE_PROVIDER_NAME = "KhazAI";
export const KHAZAI_AUTO_FREE_NAME = "KhazAI Auto Free";
export const KHAZAI_FREE_MODEL_CATEGORY = "KhazAI Free Models";

const MODELS = [
  {
    alias: "big-cock",
    displayName: "Big Cock",
    upstreamModel: "big-pickle",
    description: "General coding",
    capabilities: {
      streaming: true, tools: true, reasoning: true, usage: true, contextLimit: null,
      temperature: true, topP: true, maxOutputTokens: true, parallelTools: false,
      toolChoice: false, reasoningEffort: false,
    },
  },
  {
    alias: "boboiboy",
    displayName: "Boboiboy",
    upstreamModel: "deepseek-v4-flash-free",
    description: "Advanced reasoning and coding",
    capabilities: {
      streaming: true, tools: true, reasoning: true, usage: false, contextLimit: null,
      temperature: true, topP: true, maxOutputTokens: true, parallelTools: false,
      toolChoice: false, reasoningEffort: false,
    },
  },
  {
    alias: "komodo",
    displayName: "Komodo",
    upstreamModel: "mimo-v2.5-free",
    description: "Fast coding assistant",
    capabilities: {
      streaming: true, tools: true, reasoning: true, usage: false, contextLimit: null,
      temperature: true, topP: true, maxOutputTokens: true, parallelTools: false,
      toolChoice: false, reasoningEffort: false,
    },
  },
  {
    alias: "ombak",
    displayName: "Ombak",
    upstreamModel: "laguna-s-2.1-free",
    description: "Balanced coding model",
    capabilities: {
      streaming: true, tools: true, reasoning: false, usage: false, contextLimit: null,
      temperature: true, topP: true, maxOutputTokens: true, parallelTools: false,
      toolChoice: false, reasoningEffort: false,
    },
  },
  {
    alias: "petir",
    displayName: "Petir",
    upstreamModel: "ling-3.0-flash-free",
    description: "Lightweight and fast",
    capabilities: {
      streaming: true, tools: true, reasoning: false, usage: false, contextLimit: null,
      temperature: true, topP: true, maxOutputTokens: true, parallelTools: false,
      toolChoice: false, reasoningEffort: false,
    },
  },
  {
    alias: "kutub",
    displayName: "Kutub",
    upstreamModel: "north-mini-code-free",
    description: "Compact coding model",
    capabilities: {
      streaming: true, tools: true, reasoning: false, usage: false, contextLimit: null,
      temperature: true, topP: true, maxOutputTokens: true, parallelTools: false,
      toolChoice: false, reasoningEffort: false,
    },
  },
  {
    alias: "mecha",
    displayName: "Mecha",
    upstreamModel: "nemotron-3-ultra-free",
    description: "Tool-capable reasoning model",
    capabilities: {
      streaming: true, tools: true, reasoning: true, usage: false, contextLimit: null,
      temperature: true, topP: true, maxOutputTokens: true, parallelTools: false,
      toolChoice: false, reasoningEffort: false,
    },
  },
  {
    alias: "auto-free",
    displayName: "KhazAI Auto Free",
    upstreamModel: null,
    routing: true,
    description: "Automatic routing across healthy free models",
    capabilities: {
      streaming: true, tools: true, reasoning: true, usage: false, contextLimit: null,
      temperature: true, topP: false, maxOutputTokens: true, parallelTools: false,
      toolChoice: false, reasoningEffort: false,
    },
  },
];

function validAlias(value) {
  const alias = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{1,31}$/.test(alias) ? alias : null;
}

export function zenModels(config = {}) {
  const publicConfig = config.khazaiFree || config.openCodeZen || {};
  const configured = publicConfig.aliases || {};
  const aliases = new Set();
  return MODELS.map(model => {
    const alias = validAlias(configured[model.upstreamModel]) || model.alias;
    if (aliases.has(alias)) return { ...model, enabled: false, alias: model.alias };
    aliases.add(alias);
    const capabilityOverrides = publicConfig.capabilities?.[model.upstreamModel] || {};
    return {
      ...model,
      id: alias,
      alias,
      provider: model.provider || "khazai-free",
      transportAdapter: "openai-compatible",
      tier: "free",
      free: true,
      visible: true,
      aliases: [],
      enabled: publicConfig.disabled?.includes?.(model.upstreamModel) !== true,
      capabilities: { ...model.capabilities, ...capabilityOverrides },
    };
  });
}

export function resolveZenModel(value, config = {}) {
  const requested = String(value || "").trim().toLowerCase();
  return zenModels(config).find(model => (
    requested === model.alias
    || requested === model.upstreamModel
    || requested === `opencode/${model.upstreamModel}`
    || requested === `opencode-zen/${model.upstreamModel}`
    || requested === `khazai-free/${model.alias}`
    || requested === MODELS.find(entry => entry.upstreamModel === model.upstreamModel)?.alias
    || requested === "cock" && model.upstreamModel === "big-pickle"
  )) || null;
}

export function canonicalModelKey(value, config = {}) {
  const model = resolveZenModel(value, config);
  return model?.alias || String(value || "");
}

export function legacyModelKeys(value, config = {}) {
  const model = resolveZenModel(value, config);
  if (!model || !model.upstreamModel) return [];
  return [
    `opencode-zen/${model.upstreamModel}`,
    `opencode/${model.upstreamModel}`,
    model.upstreamModel,
  ];
}

export function stealthModelName(value, config = {}) {
  return resolveZenModel(value, config)?.alias || String(value || "");
}

export function stealthModelDisplayName(value, config = {}) {
  return resolveZenModel(value, config)?.displayName || String(value || "");
}

export function publicModelName(value, config = {}) {
  return String(value || "").toLowerCase() === "auto-free"
    ? KHAZAI_AUTO_FREE_NAME
    : stealthModelName(value, config);
}

export function sanitizePublicBranding(value, config = {}) {
  let output = String(value ?? "");
  for (const model of zenModels(config)) {
    if (!model.upstreamModel) continue;
    output = output.replace(
      new RegExp(
        `(?:opencode(?:-zen)?/|khazai-free/)?${model.upstreamModel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        "gi",
      ),
      model.alias,
    );
    output = output.replace(
      new RegExp(`(?:opencode(?:-zen)?/|khazai-free/)${model.alias}`, "gi"),
      model.alias,
    );
  }
  return output
    .replace(/\bOpenCode\s+Zen\b/gi, KHAZAI_FREE_PROVIDER_NAME)
    .replace(/\bOpenCode\b(?![/.])/gi, KHAZAI_FREE_PROVIDER_NAME)
    .replace(/\bZen(?=\s+(?:API|models?|provider|route|transport)\b)/gi, "KhazAI");
}

export function sanitizePublicSerializable(value, config = {}) {
  if (typeof value === "string") return sanitizePublicBranding(value, config);
  if (Array.isArray(value)) return value.map(entry => sanitizePublicSerializable(entry, config));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    sanitizePublicBranding(key, config),
    sanitizePublicSerializable(entry, config),
  ]));
}

export function zenModelOptions(config = {}) {
  return zenModels(config)
    .filter(model => model.enabled)
    .map(model => ({ name: model.alias, description: model.description }));
}

export function zenUpstreamIds() {
  return MODELS.map(model => model.upstreamModel).filter(Boolean);
}
