import { getOpenCodeCredential } from "./auth.js";
import { OpenAICompatibleProvider } from "./providers.js";
import {
  HEALTH_COOLDOWN_MS,
  recordRouteSuccess,
  routeAvailability,
  routeHealth,
} from "./provider-reliability.js";
import {
  KHAZAI_FREE_UPSTREAM_BASE_URL,
  resolveZenModel,
  zenModels,
  zenUpstreamIds,
} from "../config/khazai-free-models.js";

const CACHE_TTL_MS = 5 * 60_000;
const DISCOVERY_TIMEOUT_MS = 5_000;
const CHAT_ENDPOINT = `${KHAZAI_FREE_UPSTREAM_BASE_URL}/chat/completions`;

export const STATUS_LABELS = {
  available: "Available",
  cooldown: "Cooling down",
  unhealthy: "Unhealthy",
  unknown: "Status unknown",
  unavailable: "Unavailable",
  disabled: "Disabled",
  routing: "Automatic routing",
};

export function statusLabel(status) {
  return STATUS_LABELS[status] || String(status || "Status unknown");
}

let cache = {
  checkedAt: 0,
  available: null,
  error: null,
};
let rotation = 0;

function cached(now = Date.now()) {
  return cache.checkedAt > 0 && now - cache.checkedAt < CACHE_TTL_MS;
}

export async function refreshZenAvailability({
  force = false,
  now = Date.now(),
} = {}) {
  if (!force && cached(now)) return availabilitySnapshot();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Model discovery timed out")), DISCOVERY_TIMEOUT_MS);
  timer.unref?.();
  try {
    const provider = new OpenAICompatibleProvider({
      id: "khazai-free",
      baseURL: KHAZAI_FREE_UPSTREAM_BASE_URL,
      apiKey: getOpenCodeCredential(),
    });
    const discovered = await provider.listModels({ signal: controller.signal });
    cache = {
      checkedAt: now,
      available: new Set(discovered.filter(id => zenUpstreamIds().includes(id))),
      error: null,
    };
    for (const model of cache.available) {
      recordRouteSuccess("khazai-free", model, CHAT_ENDPOINT, 0, now);
    }
  } catch (error) {
    cache = {
      checkedAt: now,
      available: cache.available,
      error: String(error?.message || error),
    };
  } finally {
    clearTimeout(timer);
  }
  return availabilitySnapshot();
}

export function availabilitySnapshot(config = {}, now = Date.now()) {
  return zenModels(config).map(model => {
    if (!model.upstreamModel) {
      return {
        ...model,
        status: "routing",
        checkedAt: cache.checkedAt,
        discoveryError: cache.error,
        retryAt: null,
      };
    }
    const discovered = cache.available;
    const state = routeHealth("khazai-free", model.upstreamModel, CHAT_ENDPOINT, now);
    const health = routeAvailability("khazai-free", model.upstreamModel, CHAT_ENDPOINT, 0, now);
    const recentlyFailed = state.lastFailureAt > 0 && now - state.lastFailureAt < HEALTH_COOLDOWN_MS;
    const status = !model.enabled
      ? "disabled"
      : discovered && !discovered.has(model.upstreamModel)
        ? "unavailable"
        : state.unhealthyUntil > now
          ? "unhealthy"
          : recentlyFailed || state.toolIncompatibleUntil > now
            ? "cooldown"
            : discovered
              ? "available"
              : "unknown";
    return {
      ...model,
      status,
      checkedAt: cache.checkedAt,
      discoveryError: cache.error,
      retryAt: health.retryAt || null,
    };
  });
}

export function modelStatusList(config = {}, now = Date.now()) {
  return availabilitySnapshot(config, now)
    .filter(model => model.visible !== false && model.enabled !== false)
    .map(model => ({
      alias: model.alias,
      displayName: model.displayName,
      status: model.status,
      statusLabel: statusLabel(model.status),
      capabilities: model.capabilities,
    }));
}

export function selectableZenModels(config = {}, now = Date.now()) {
  return availabilitySnapshot(config, now)
    .filter(model => model.upstreamModel)
    .filter(model => ["available", "unknown"].includes(model.status));
}

function candidateScore(model, requirements, now) {
  const state = routeHealth("khazai-free", model.upstreamModel, CHAT_ENDPOINT, now);
  const contextKnown = Number(model.capabilities.contextLimit) > 0;
  return [
    requirements.tools && model.capabilities.tools ? 100 : 0,
    (requirements.reasoning || requirements.preferReasoning) && model.capabilities.reasoning ? 40 : 0,
    requirements.preferKnownContext && contextKnown ? 20 : 0,
    Math.max(0, 10 - state.consecutiveFailures * 3),
  ].reduce((sum, value) => sum + value, 0);
}

export function zenRouteCandidates(config = {}, requirements = {}, excluded = new Set(), now = Date.now()) {
  const candidates = selectableZenModels(config, now)
    .filter(model => model.upstreamModel && !excluded.has(model.upstreamModel))
    .filter(model => !requirements.tools || model.capabilities.tools)
    .filter(model => !requirements.reasoning || model.capabilities.reasoning)
    .sort((left, right) => candidateScore(right, requirements, now) - candidateScore(left, requirements, now));
  if (candidates.length < 2) return candidates;
  const topScore = candidateScore(candidates[0], requirements, now);
  const top = candidates.filter(model => candidateScore(model, requirements, now) === topScore);
  const selected = top[rotation++ % top.length];
  return [selected, ...candidates.filter(model => model !== selected)];
}

export function zenModelStatus(alias, config = {}, now = Date.now()) {
  const model = resolveZenModel(alias, config);
  if (!model) return null;
  return availabilitySnapshot(config, now)
    .find(entry => entry.upstreamModel === model.upstreamModel) || null;
}

export function resetZenCatalog() {
  cache = { checkedAt: 0, available: null, error: null };
  rotation = 0;
}
