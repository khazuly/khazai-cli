import { configuredModels, loadConfig } from "../config/index.js";
import { resolveProviderCapabilities } from "../config/model-settings.js";
import {
  KHAZAI_FREE_MODEL_CATEGORY,
  KHAZAI_FREE_PROVIDER_NAME,
  resolveZenModel,
  zenModels,
} from "../config/khazai-free-models.js";
import {
  modelStatusList as zenModelStatusList,
  refreshZenAvailability,
  statusLabel,
} from "../lib/khazai-free-model-catalog.js";

export const EXCEPTIONAL_STATUSES = new Set(["cooldown", "unhealthy", "unknown", "unavailable", "disabled"]);

function supported(value) {
  return value ? "Supported" : "Not supported";
}

export async function modelStatusList({ force = false } = {}) {
  const config = loadConfig();
  await refreshZenAvailability({ force });
  return zenModelStatusList(config);
}

export async function selectableModels({ freeOnly = false, force = false } = {}) {
  const config = loadConfig();
  const list = await modelStatusList({ force });
  const free = list.map(model => model.alias);
  if (freeOnly) return free;
  const zenAliases = new Set(zenModels(config).map(model => model.alias));
  return [
    ...free,
    ...configuredModels().filter(model => model !== "auto-free" && !zenAliases.has(model)),
  ];
}

export async function modelDetails(alias) {
  const config = loadConfig();
  await refreshZenAvailability();
  const model = zenModelStatusList(config).find(entry => entry.alias === String(alias).toLowerCase());
  if (!model) return null;
  const capabilities = resolveProviderCapabilities(model.alias, {
    capabilities: model.capabilities,
  });
  const context = Number(model.capabilities.contextLimit) > 0
    ? Number(model.capabilities.contextLimit).toLocaleString("en-US")
    : "Unknown";
  const lines = [
    `Model       ${model.displayName}`,
    `Provider    ${KHAZAI_FREE_PROVIDER_NAME}`,
    "Tier        Free",
  ];
  if (EXCEPTIONAL_STATUSES.has(model.status)) {
    lines.push(`Status      ${model.statusLabel}`);
  }
  lines.push(
    `Tools       ${supported(capabilities.supportsToolCalling)}`,
    `Reasoning   ${supported(model.capabilities.reasoning)}`,
    `Context     ${context}`,
  );
  return lines.join("\n");
}

export async function modelUnavailable(alias) {
  const config = loadConfig();
  const model = resolveZenModel(alias, config);
  if (!model) return false;
  await refreshZenAvailability();
  const status = zenModelStatusList(config)
    .find(entry => entry.alias === model.alias)?.status;
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

export function formatModelStatusList(list) {
  const lines = list.map(model => {
    const status = EXCEPTIONAL_STATUSES.has(model.status) ? ` (${statusLabel(model.status)})` : "";
    return `- ${model.alias}${status}`;
  });
  return [KHAZAI_FREE_MODEL_CATEGORY, "", ...lines].join("\n");
}
