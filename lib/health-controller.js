import {
  fingerprintIsHealthy,
  isFallbackEligibleFailure,
  recordRouteFailureByFingerprint,
  recordRouteSuccessByFingerprint,
  routeHealthByFingerprint,
  FAILURE_THRESHOLD,
} from "./provider-reliability.js";
import { resolveRoute, sameRoute } from "./route-registry.js";
import { resolveZenModel } from "../config/khazai-free-models.js";

/**
 * Health and fallback controller.
 *
 * Fallback is only allowed toward a genuinely distinct upstream route
 * (different fingerprint). Switching the visible alias while the resolved
 * provider, endpoint, upstream model, and credential pool stay the same is
 * not a fallback and is never counted as one.
 */

export function recordRouteFailure(route, failureClass, toolCount = 0, now = Date.now()) {
  return recordRouteFailureByFingerprint(route?.fingerprint || route, failureClass, toolCount, now);
}

export function recordRouteSuccess(route, toolCount = 0, now = Date.now()) {
  return recordRouteSuccessByFingerprint(route?.fingerprint || route, toolCount, now);
}

export function routeHealth(route, now = Date.now()) {
  return routeHealthByFingerprint(route?.fingerprint || route, now);
}

export function routeIsHealthy(route, now = Date.now()) {
  return Boolean(route?.fingerprint && fingerprintIsHealthy(route.fingerprint, now));
}

export function fallbackCandidates({
  alias,
  config = {},
  usedFingerprints = new Set(),
  requirements = {},
  now = Date.now(),
}) {
  const current = resolveRoute(alias, config);
  const candidates = [];
  if (config.fallbackModel && String(config.fallbackModel) !== String(alias)) {
    candidates.push({ alias: String(config.fallbackModel), source: "config" });
  }
  const freeAliases = Array.isArray(config.khazaiFreeModels?.aliases)
    ? config.khazaiFreeModels.aliases
    : [];
  for (const freeAlias of freeAliases) {
    if (String(freeAlias) === String(alias)) continue;
    if (!resolveZenModel(freeAlias, config)) continue;
    candidates.push({ alias: freeAlias, source: "catalog" });
  }
  const resolved = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate.alias)) continue;
    seen.add(candidate.alias);
    try {
      const route = resolveRoute(candidate.alias, config);
      if (sameRoute(route, current)) continue;
      if (usedFingerprints.has(route.fingerprintKey)) continue;
      if (!fingerprintIsHealthy(route.fingerprint, now)) continue;
      if (requirements.supportsTools && route.capabilities?.supportsToolCalling === false) continue;
      if (requirements.supportsReasoning && route.capabilities?.supportsReasoningEffort === false) continue;
      resolved.push({ ...route, fallbackAlias: route.alias, source: candidate.source });
    } catch {
      // Unresolvable aliases are skipped silently.
    }
  }
  return resolved;
}

export function selectFallback({
  alias,
  config = {},
  requirements = {},
  usedFingerprints = new Set(),
  now = Date.now(),
}) {
  const candidates = fallbackCandidates({ alias, config, requirements, usedFingerprints, now });
  return candidates[0] || null;
}

export function fallbackEligible(failureClass) {
  return isFallbackEligibleFailure(failureClass);
}

export { FAILURE_THRESHOLD };
