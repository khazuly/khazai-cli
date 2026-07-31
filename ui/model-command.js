import { configuredModels, loadConfig } from "../config/index.js";
import { resolveProviderCapabilities } from "../config/model-settings.js";
import {
  KHAZAI_FREE_MODEL_CATEGORY,
  KHAZAI_FREE_PROVIDER_NAME,
  resolveZenModel,
  zenModels,
} from "../config/khazai-free-models.js";
import {
  refreshZenAvailability,
  selectableZenModels,
  zenModelStatus,
} from "../lib/khazai-free-model-catalog.js";

function supported(value) {
  return value ? "Supported" : "Not supported";
}

export async function selectableModels({ freeOnly = false, force = false } = {}) {
  const config = loadConfig();
  await refreshZenAvailability({ force });
  const free = selectableZenModels(config).map(model => model.alias);
  if (freeOnly) return free;
  const zenAliases = new Set(zenModels(config).map(model => model.alias));
  return [
    ...free,
    "auto-free",
    ...configuredModels().filter(model => model !== "auto-free" && !zenAliases.has(model)),
  ];
}

export async function modelDetails(alias) {
  const config = loadConfig();
  await refreshZenAvailability();
  const model = zenModelStatus(alias, config);
  if (!model) return null;
  const capabilities = resolveProviderCapabilities(model.alias, { zenModel: model });
  const context = Number(model.capabilities.contextLimit) > 0
    ? Number(model.capabilities.contextLimit).toLocaleString("en-US")
    : "Unknown";
  return [
    `Model        ${model.displayName}`,
    `Provider     ${KHAZAI_FREE_PROVIDER_NAME}`,
    "Tier         Free",
    `Status       ${model.status.charAt(0).toUpperCase()}${model.status.slice(1)}`,
    `Tools        ${supported(capabilities.supportsToolCalling)}`,
    `Reasoning    ${supported(model.capabilities.reasoning)}`,
    `Context      ${context}`,
  ].join("\n");
}

export async function modelUnavailable(alias) {
  const config = loadConfig();
  const model = resolveZenModel(alias, config);
  if (!model) return false;
  await refreshZenAvailability();
  const status = zenModelStatus(model.alias, config)?.status;
  return ["disabled", "unavailable"].includes(status);
}

export function modelAliases({ debug = false } = {}) {
  const config = loadConfig();
  return [
    KHAZAI_FREE_MODEL_CATEGORY,
    "",
    ...zenModels(config).map(model => (
      debug && process.env.KHAZAI_DEBUG
        ? `- ${model.alias} (${model.upstreamModel})`
        : `- ${model.alias}`
    )),
  ].join("\n");
}

export function modelSelectionDescription(alias) {
  const model = resolveZenModel(alias, loadConfig());
  return model?.description || alias;
}
