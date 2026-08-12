import { OpenAICompatibleProvider } from "./providers.js";

export const QWEN_CLOUD_ID = "qwen-cloud";
export const QWEN_CLOUD_NAME = "Qwen Cloud";
export const QWEN_CLOUD_BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

const catalog = [
  ["qwen/qwen3.7-max", "qwen3.7-max", "qwen", "qwen", true, false],
  ["qwen/qwen3.7-plus", "qwen3.7-plus", "qwen", "qwen", true, true],
  ["qwen/qwen3.6-plus", "qwen3.6-plus", "qwen", "qwen", true, true],
  ["qwen/qwen3.5-plus", "qwen3.5-plus", "qwen", "qwen", true, true],
  ["qwen/qwen3-coder", "qwen3-coder", "qwen", "qwen", false, false],
  ["deepseek/deepseek-v4-pro", "deepseek-v4-pro", "deepseek", "deepseek", true, false],
  ["deepseek/deepseek-v4-flash", "deepseek-v4-flash", "deepseek", "deepseek", true, false],
  ["kimi/kimi-k2.6", "kimi-k2.6", "kimi", "kimi", true, true],
  ["glm/glm-5", "glm-5", "glm", "default", true, false],
].map(([publicName, upstreamModelId, family, promptProfile, reasoning, vision]) => Object.freeze({
  publicName,
  upstreamModelId,
  provider: QWEN_CLOUD_ID,
  family,
  promptProfile,
  contextLimit: null,
  capabilities: Object.freeze({
    streaming: true,
    tools: true,
    parallelTools: true,
    reasoning,
    vision,
    contextLimit: null,
  }),
}));

const byPublicName = new Map(catalog.map(model => [model.publicName, model]));
const byUpstreamId = new Map(catalog.map(model => [model.upstreamModelId, model]));
const clients = new Map();

export function qwenCloudCatalog() {
  return catalog.map(model => ({ ...model, capabilities: { ...model.capabilities } }));
}

export function findQwenCloudModel(name, models = catalog) {
  const value = String(name || "").toLowerCase();
  if (Array.isArray(models)) {
    return models.find(model => String(model?.publicName || "").toLowerCase() === value) || null;
  }
  return byPublicName.get(value) || null;
}

export function qwenCloudModelsForUpstreams(upstreamIds = []) {
  const available = new Set(upstreamIds.map(id => String(id || "").toLowerCase()));
  return catalog.filter(model => available.has(model.upstreamModelId));
}

function connectionError(status) {
  const messages = {
    401: "authentication was rejected",
    403: "access was denied",
    404: "the endpoint or selected model is unavailable",
    429: "the provider is rate limited",
  };
  if (messages[status]) return new Error(messages[status]);
  if (status >= 500) return new Error("the provider is temporarily unavailable");
  return new Error("the provider could not be reached");
}

async function readModels(fetchImpl, apiKey, signal) {
  const response = await fetchImpl(`${QWEN_CLOUD_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });
  if (response.status === 404 || response.status === 405) return null;
  if (!response.ok) throw connectionError(response.status);
  const body = await response.json().catch(() => ({}));
  const ids = (body.data || body.models || [])
    .map(model => typeof model === "string" ? model : model?.id)
    .filter(Boolean);
  return qwenCloudModelsForUpstreams(ids);
}

export function qwenCloudClient({ apiKey, baseURL = QWEN_CLOUD_BASE_URL } = {}) {
  const key = `${baseURL}\u0000${apiKey}`;
  if (!clients.has(key)) {
    clients.set(key, new OpenAICompatibleProvider({
      id: QWEN_CLOUD_ID,
      baseURL,
      apiKey,
    }));
  }
  return clients.get(key);
}

export function clearQwenCloudClient() {
  clients.clear();
}

export async function validateQwenCloudConnection({ apiKey, fetchImpl = fetch, signal } = {}) {
  if (!String(apiKey || "").trim()) throw new Error("an API key is required");
  let models;
  try {
    models = await readModels(fetchImpl, apiKey, signal);
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new Error(error?.message || "the provider could not be reached");
  }
  const discovered = models || qwenCloudCatalog();
  if (!discovered.length) throw new Error("no supported chat or coding models are available");
  const probe = discovered.find(model => model.upstreamModelId === "qwen3.7-plus") || discovered[0];
  const response = await fetchImpl(`${QWEN_CLOUD_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: probe.upstreamModelId,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      stream: false,
    }),
    signal,
  });
  if (!response.ok) throw connectionError(response.status);
  return discovered;
}
