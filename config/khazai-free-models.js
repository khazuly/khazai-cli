export const KHAZAI_FREE_UPSTREAM_BASE_URL = "https://opencode.ai/zen/v1";
export const KHAZAI_FREE_PROVIDER_ID = "khazai-free";
export const KHAZAI_FREE_PROVIDER_NAME = "KhazAI";
export const KHAZAI_AUTO_FREE_NAME = "KhazAI Auto Free";
export const KHAZAI_FREE_MODEL_CATEGORY = "KhazAI Free Models";

const TOOL_REASONING_CAPABILITIES = {
  streaming: true,
  tools: true,
  reasoning: true,
  usage: false,
  contextLimit: null,
  temperature: true,
  topP: true,
  maxOutputTokens: true,
  parallelTools: true,
  toolChoice: false,
  reasoningEffort: false,
};

const TOOL_CAPABILITIES = {
  ...TOOL_REASONING_CAPABILITIES,
  reasoning: false,
};

const MODELS = [
  {
    alias: "big-cock",
    publicName: "Big Cock",
    upstreamModel: "big-pickle",
    description: "General coding",
    capabilities: { ...TOOL_REASONING_CAPABILITIES, usage: true },
  },
  {
    alias: "boboiboy",
    publicName: "deepseek/deepseek-v4-flash-free",
    upstreamModel: "deepseek-v4-flash-free",
    description: "Advanced reasoning and coding",
    capabilities: TOOL_REASONING_CAPABILITIES,
  },
  {
    alias: "komodo",
    publicName: "mimo/mimo-v2.5-free",
    upstreamModel: "mimo-v2.5-free",
    description: "Fast coding assistant",
    capabilities: TOOL_REASONING_CAPABILITIES,
  },
  {
    alias: "ombak",
    publicName: "laguna/laguna-s-2.1-free",
    upstreamModel: "laguna-s-2.1-free",
    description: "Balanced coding model",
    capabilities: TOOL_CAPABILITIES,
  },
  {
    alias: "petir",
    publicName: "hy3/hy3-free",
    upstreamModel: "hy3-free",
    description: "Lightweight and fast",
    capabilities: TOOL_CAPABILITIES,
  },
  {
    alias: "kutub",
    publicName: "nemotron/nemotron-3-ultra-free",
    upstreamModel: "nemotron-3-ultra-free",
    description: "Compact coding model",
    capabilities: TOOL_CAPABILITIES,
  },
  {
    alias: "mecha",
    publicName: "nemotron/nemotron-3.5-lightning-free",
    upstreamModel: "nemotron-3.5-lightning-free",
    description: "Tool-capable reasoning model",
    capabilities: TOOL_REASONING_CAPABILITIES,
  },
  {
    alias: "auto-free",
    publicName: KHAZAI_AUTO_FREE_NAME,
    upstreamModel: null,
    routing: true,
    description: "Automatic routing across healthy free models",
    capabilities: {
      streaming: true,
      tools: true,
      reasoning: true,
      usage: false,
      contextLimit: null,
      temperature: true,
      topP: false,
      maxOutputTokens: true,
      parallelTools: true,
      toolChoice: false,
      reasoningEffort: false,
    },
  },
];

function validAlias(value) {
  const alias = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{1,31}$/.test(alias) ? alias : null;
}

export function shortModelName(value) {
  const name = String(value || "").trim();
  const separator = name.indexOf("/");
  return separator > 0 && separator < name.length - 1 ? name.slice(separator + 1) : name;
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
    const publicName = model.publicName || model.alias;
    return {
      ...model,
      id: alias,
      alias,
      publicName,
      displayName: shortModelName(publicName),
      key: model.alias === "big-cock" || !model.upstreamModel ? model.alias : publicName,
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
  return zenModels(config).find(model => {
    const publicKey = String(model.publicName || "").trim().toLowerCase();
    const normalizedPublic = publicKey.replace(/\s+/g, "-");
    return requested === model.alias
      || requested === model.upstreamModel
      || requested === `opencode/${model.upstreamModel}`
      || requested === `opencode-zen/${model.upstreamModel}`
      || requested === `khazai-free/${model.alias}`
      || requested === publicKey
      || requested === normalizedPublic
      || requested === MODELS.find(entry => entry.upstreamModel === model.upstreamModel)?.alias
      || requested === "cock" && model.alias === "big-cock";
  }) || null;
}

export function canonicalModelKey(value, config = {}) {
  const model = resolveZenModel(value, config);
  return model?.key || String(value || "");
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

export function publicModelName(value, config = {}) {
  const model = resolveZenModel(value, config);
  return model?.displayName || shortModelName(value);
}

export function sanitizePublicBranding(value, config = {}) {
  let output = String(value ?? "");
  for (const model of zenModels(config)) {
    if (!model.upstreamModel) continue;
    const upstream = model.upstreamModel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const alias = model.alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    output = output.replace(
      new RegExp(`(?<![\\w/-])(?:opencode(?:-zen)?/|khazai-free/)?${upstream}`, "gi"),
      model.publicName,
    );
    output = output.replace(
      new RegExp(`(?<![\\w/-])(?:opencode(?:-zen)?/|khazai-free/)${alias}`, "gi"),
      model.publicName,
    );
  }
  return output
    .replace(/\bOpenCode\s+Zen\b/gi, KHAZAI_FREE_PROVIDER_NAME)
    .replace(/\bOpenCode\b(?![/.])/gi, KHAZAI_FREE_PROVIDER_NAME)
    .replace(/\bZen(?=\s+(?:API|models?|provider|route|transport)\b)/gi, "KhazAI");
}

export function sanitizePublicSerializable(value, config = {}) {
  if (typeof value === "string") return sanitizePublicBranding(value, config);
  if (Array.isArray(value)) return value.map(item => sanitizePublicSerializable(item, config));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, sanitizePublicSerializable(entry, config)]),
  );
}

export function zenUpstreamIds(config = {}) {
  return zenModels(config).filter(model => model.upstreamModel).map(model => model.upstreamModel);
}

export function zenModelAliases(config = {}) {
  return zenModels(config).map(model => model.alias);
}
