import { resolveModelDescriptor } from "./model-resolver.js";
import { providerIdFromModel } from "../config/model-settings.js";
import { resolveZenModel } from "../config/khazai-free-models.js";
import { fingerprintKey } from "./provider-reliability.js";

/**
 * Stable route identity for upstream provider endpoints.
 *
 * A "route" is the real upstream call target: provider, endpoint, upstream
 * model, and the credential pool it draws from. Two public aliases that
 * resolve to the same fingerprint are the same route and must never be
 * treated as fallback alternatives.
 */

export function credentialPoolId(providerId, definition = {}, config = {}) {
  if (providerId === "opencode" || providerId === "khazai-free") return "opencode";
  if (providerId === "codex") return "codex";
  if (definition?.env) return String(definition.env);
  const provider = config.providers?.[providerId];
  if (provider?.env) return String(provider.env);
  return providerId;
}

export function routeFingerprint(descriptor) {
  return {
    providerId: String(descriptor?.providerID || descriptor?.providerId || "unknown"),
    baseURL: String(descriptor?.definition?.baseURL || ""),
    upstreamModel: String(descriptor?.modelID || descriptor?.upstreamModel || "unknown"),
    credentialPoolId: credentialPoolId(
      descriptor?.providerID || descriptor?.providerId,
      descriptor?.definition,
    ),
  };
}

export function routeIdFor(fingerprint) {
  if (!fingerprint) return "";
  return `${fingerprint.providerId}:${fingerprint.upstreamModel}`;
}

export function sameRoute(left, right) {
  return Boolean(left && right && fingerprintKey(left) === fingerprintKey(right));
}

export function resolveRoute(alias, config = {}) {
  const descriptor = resolveModelDescriptor(alias, config);
  const fingerprint = routeFingerprint(descriptor);
  const route = {
    alias: String(alias || ""),
    routeId: routeIdFor(fingerprint),
    providerId: fingerprint.providerId,
    baseURL: fingerprint.baseURL,
    upstreamModel: fingerprint.upstreamModel,
    credentialPoolId: fingerprint.credentialPoolId,
    adapterId: descriptor.providerID === "codex" ? "codex-responses" : "openai-compatible",
    capabilities: descriptor.definition?.capabilities || null,
    displayName: descriptor.definition?.displayName || null,
    definition: descriptor.definition,
    descriptor,
    fingerprint,
    fingerprintKey: fingerprintKey(fingerprint),
  };
  return route;
}

export function zenRouteFor(alias, config = {}) {
  const model = resolveZenModel(alias, config);
  if (!model) return null;
  const route = resolveRoute(model.alias, config);
  route.alias = model.alias;
  route.modelAlias = model.alias;
  route.displayName = model.displayName || route.displayName;
  route.capabilities = { ...(model.capabilities || {}), ...(route.capabilities || {}) };
  return route;
}

export function routeIdentity(alias, config = {}) {
  const route = resolveZenModel(alias, config) ? zenRouteFor(alias, config) : resolveRoute(alias, config);
  return {
    alias: route?.alias || alias,
    routeId: route?.routeId || String(alias || ""),
    providerId: route?.providerId || providerIdFromModel(alias),
    upstreamModel: route?.upstreamModel || null,
    fingerprint: route?.fingerprint || null,
    fingerprintKey: route?.fingerprintKey || "",
  };
}
