import { loadConfig } from "../config/index.js";
import { resolveEffectiveSettings, resolveProviderCapabilities } from "../config/model-settings.js";
import { getOpenCodeCredential, getProviderCredential } from "./auth.js";
import { CodexResponsesProvider } from "./codex-provider.js";
import { mergeToolCallDelta, OpenAICompatibleProvider } from "./providers.js";
import { resolveModelDescriptor } from "./model-resolver.js";
import { resolveRoute } from "./route-registry.js";
import { countTokens } from "./tokens.js";
import { preflightContext } from "./request-normalizer.js";
import {
  classifyProviderFailure,
  isFallbackEligibleFailure,
  isRetryableFailure,
  plainRouteHealthy,
  providerAttemptId,
  providerDiagnostic,
  recordRouteFailure,
  recordRouteSuccess,
  recordRouteFailureByFingerprint,
  recordRouteSuccessByFingerprint,
  routeAvailability,
  routeAvailabilityByFingerprint,
} from "./provider-reliability.js";
import { zenRouteCandidates } from "./khazai-free-model-catalog.js";
import { selectFallback } from "./health-controller.js";
export { resolveModelDescriptor, mergeToolCallDelta };
function routeOptions(options, route) {
  if (!route) return options;
  return {
    ...options,
    route,
    alias: route.alias,
    routeId: route.routeId,
    upstreamModel: route.upstreamModel,
  };
}
function routeDiagnosticExtra(options, route) {
  return {
    alias: options.alias || route?.alias || "",
    routeId: options.routeId || route?.routeId || "",
    upstreamModel: options.upstreamModel || route?.upstreamModel || options.model || "",
    adapter: options.adapterId || route?.adapterId || "",
    fingerprint: route?.fingerprint || null,
    fallbackSelected: options.fallbackSelected || "",
  };
}
export function resolveProvider(model, config = loadConfig()) {
  const descriptor = resolveModelDescriptor(model, config);
  if (descriptor.providerID === "codex") {
    return {
      provider: new CodexResponsesProvider({ model: descriptor.modelID }),
      model: descriptor.modelID,
      id: descriptor.providerID,
      requested: descriptor.requested,
      exactID: descriptor.exactID,
      apiKey: "",
      definition: descriptor.definition,
    };
  }
  const apiKey = getProviderCredential(descriptor.providerID, descriptor.definition.env)
    || (["opencode", "khazai-free"].includes(descriptor.providerID) ? getOpenCodeCredential() : "");
  return {
    provider: new OpenAICompatibleProvider({
      id: descriptor.providerID,
      baseURL: descriptor.definition.baseURL,
      apiKey,
      headers: descriptor.definition.headers || {},
      rotateSessionAffinity: ["opencode", "khazai-free"].includes(descriptor.providerID),
      compatibility: descriptor.definition.compatibility || {},
    }),
    model: descriptor.modelID,
    id: descriptor.providerID,
    requested: descriptor.requested,
    exactID: descriptor.exactID,
    apiKey,
    definition: descriptor.definition,
  };
}
function canRetryAutoFreeAnonymously(resolved, error) {
  return resolved.id === "auto-free"
    && Boolean(resolved.apiKey)
    && /^HTTP 5\d\d:/.test(String(error?.message || error));
}
function canRetryOpenCodeAnonymously(resolved, error) {
  return resolved.id === "opencode"
    && Boolean(resolved.apiKey)
    && [401, 403].includes(Number(error?.status));
}
function anonymousProvider(resolved) {
  return new OpenAICompatibleProvider({
    id: resolved.id,
    baseURL: resolved.definition.baseURL,
    headers: resolved.definition.headers || {},
    rotateSessionAffinity: ["opencode", "khazai-free"].includes(resolved.id),
  });
}
function openCodeRequestOptions(resolved, options) {
  if (!["opencode", "khazai-free"].includes(resolved.id)) return options;
  const sessionId = String(options.sessionId || options.turnId || "");
  const requestId = String(options.requestId || options.runId || "");
  return {
    ...options,
    requestId,
    includeUsage: true,
    maxTokens: options.maxTokens ?? 32_000,
    toolChoice: options.toolChoice ?? null,
    headers: {
      ...(sessionId ? { "x-opencode-session": sessionId } : {}),
      ...(requestId ? { "x-opencode-request": requestId } : {}),
      "x-opencode-client": "khazai-cli",
      "User-Agent": "khazai-ai/0.3.0",
      ...(options.headers || {}),
    },
  };
}
export function isTransientProviderError(error) {
  return isRetryableFailure(error?.failureClass || classifyProviderFailure(error));
}
export function providerRetryDelay(error, retryIndex, random = Math.random) {
  const requested = Number(error?.retryAfterMs);
  if (Number.isFinite(requested) && requested >= 0) return Math.min(60_000, requested);
  const base = [1_000, 2_500, 6_000][retryIndex] || 6_000;
  return Math.round(base * (0.8 + Math.max(0, Math.min(1, random())) * 0.4));
}
function waitForRetry(signal, delayMs) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error("Cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    timer.unref?.();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function attemptCallbacks(options) {
  const events = [];
  const next = { ...options };
  if (options.onEvent) {
    next.onEvent = event => {
      if (event?.type !== "error") events.push({ kind: "event", value: event });
    };
  }
  if (!options.onEvent && options.onToken) {
    next.onToken = token => events.push({ kind: "token", value: token });
  }
  return {
    options: next,
    publish() {
      for (const entry of events) {
        if (entry.kind === "event") options.onEvent?.(entry.value);
        else options.onToken?.(entry.value);
      }
    },
  };
}
function activeRequest(options) {
  return !options.signal?.aborted && (!options.isActive || options.isActive({
    runId: options.runId,
    turnId: options.turnId,
    taskEpoch: options.taskEpoch,
    requestId: options.requestId,
  }));
}
function attemptOptions(options, requestId) {
  const headers = options.headers?.["x-opencode-request"]
    ? { ...options.headers, "x-opencode-request": requestId }
    : options.headers;
  return { ...options, requestId, headers };
}
function combinedAvailability(provider, options, endpoint, toolCount) {
  const route = options.route || null;
  const legacy = endpoint && !options.bypassProviderHealth
    ? routeAvailability(provider?.id || options.model, options.model, endpoint, toolCount)
    : null;
  const fingerprint = !options.bypassProviderHealth && route?.fingerprint
    ? routeAvailabilityByFingerprint(route.fingerprint, toolCount)
    : null;
  if (!legacy && !fingerprint) return { available: true };
  const legacyUnavailable = legacy && !legacy.available;
  const fingerprintUnavailable = fingerprint && !fingerprint.available;
  if (!legacyUnavailable && !fingerprintUnavailable) return { available: true };
  const failureClass = legacyUnavailable ? legacy.failureClass : fingerprint?.failureClass || "unhealthy_model_route";
  const retryAt = Math.max(
    legacy?.retryAt || 0,
    fingerprint?.retryAt || 0,
  ) || null;
  return { available: false, failureClass, retryAt };
}
export async function chatWithRetry(provider, messages, options, attempts = 3) {
  let error;
  const retryLog = [];
  const maximumAttempts = Math.max(1, Number(attempts) || 1);
  const endpoint = provider.chatURL?.() || provider.endpoint || "";
  const toolCount = options.tools?.length || 0;
  const route = options.route || null;
  const availability = combinedAvailability(provider, options, endpoint, toolCount);
  if (!availability.available) {
    error = new Error("The selected model route is temporarily unavailable.");
    error.failureClass = availability.failureClass;
    error.endpoint = endpoint;
    error.attempts = 0;
    error.routeFingerprintKey = route?.fingerprintKey || "";
    throw error;
  }
  for (let attempt = 0; attempt < maximumAttempts; attempt++) {
    if (!activeRequest(options)) throw options.signal?.reason || new Error("Cancelled");
    const requestId = providerAttemptId(options.requestId, attempt);
    const scopedOptions = attemptOptions(options, requestId);
    const callbacks = attemptCallbacks(scopedOptions);
    let activeAttemptOptions = callbacks.options;
    try {
      activeAttemptOptions = provider.retryOptions?.(callbacks.options, attempt) || callbacks.options;
      const result = await provider.chat(messages, activeAttemptOptions);
      if (!activeRequest(activeAttemptOptions)) {
        throw options.signal?.reason || new Error("Cancelled");
      }
      if (endpoint) recordRouteSuccess(provider.id, scopedOptions.model, endpoint, toolCount);
      if (route?.fingerprint) recordRouteSuccessByFingerprint(route.fingerprint, toolCount);
      callbacks.publish();
      return result;
    } catch (caught) {
      error = caught;
      error.attempts = attempt + 1;
      if (!activeRequest(activeAttemptOptions)) {
        throw options.signal?.reason || new Error("Cancelled");
      }
      const failureClass = error.failureClass || classifyProviderFailure(error, {
        toolCount,
        plainRouteHealthy: endpoint
          ? plainRouteHealthy(provider.id, scopedOptions.model, endpoint)
          : false,
      });
      error.failureClass = failureClass;
      const delayMs = isRetryableFailure(failureClass) && attempt < maximumAttempts - 1
        ? providerRetryDelay(error, attempt, options.retryRandom)
        : null;
      const diagnostic = providerDiagnostic(
        provider,
        activeAttemptOptions,
        error,
        attempt + 1,
        failureClass,
        delayMs,
        routeDiagnosticExtra(scopedOptions, route),
      );
      retryLog.push(diagnostic);
      if (endpoint) {
        recordRouteFailure(provider.id, scopedOptions.model, endpoint, failureClass, toolCount);
      }
      if (route?.fingerprint) {
        recordRouteFailureByFingerprint(route.fingerprint, failureClass, toolCount);
      }
      error.routeFingerprintKey = route?.fingerprintKey || "";
      if (!isRetryableFailure(failureClass) || attempt === maximumAttempts - 1) {
        error.retryLog = retryLog;
        throw error;
      }
      if (!activeRequest(activeAttemptOptions)) {
        throw options.signal?.reason || new Error("Cancelled");
      }
      await waitForRetry(options.signal, delayMs);
    }
  }
  throw error;
}
function freeRouteOptions(resolved, baseOptions, candidate, config) {
  const candidateSettings = resolveEffectiveSettings(candidate.alias, { config });
  const candidateCapabilities = resolveProviderCapabilities(candidate.alias, {
    capabilities: candidate.capabilities,
  });
  return {
    ...baseOptions,
    model: resolved.model,
    capabilities: candidateCapabilities,
    parallelToolCalls: candidateCapabilities.supportsParallelTools && candidateSettings.parallelToolCalls,
    reasoningEffort: candidateCapabilities.supportsReasoningEffort
      ? baseOptions.reasoningEffort
      : undefined,
    temperature: candidateCapabilities.supportsTemperature
      ? baseOptions.temperature ?? candidateSettings.temperature
      : undefined,
    topP: candidateCapabilities.supportsTopP ? baseOptions.topP ?? candidateSettings.topP : undefined,
    maxTokens: candidateCapabilities.supportsMaxTokens
      ? baseOptions.maxTokens ?? candidateSettings.maxOutputTokens
      : undefined,
  };
}
async function chatWithFreeRoutes(messages, options, attempts, config, legacy) {
  const settings = resolveEffectiveSettings("auto-free", { config });
  const requirements = {
    tools: (options.tools?.length || 0) > 0,
    preferReasoning: true,
    preferKnownContext: settings.preferModelsWithContextLimits === true,
  };
  const maxRoutes = Math.max(1, Number(settings.maxModelAttempts) || 3);
  const candidates = zenRouteCandidates(config, requirements, new Set(), Date.now())
    .slice(0, maxRoutes);
  const usedFingerprints = new Set([options.route?.fingerprintKey].filter(Boolean));
  let failedRoutes = 0;
  for (const candidate of candidates) {
    const resolved = resolveProvider(candidate.alias, config);
    const candidateRoute = resolveRoute(candidate.alias, config);
    if (candidateRoute.fingerprintKey && usedFingerprints.has(candidateRoute.fingerprintKey)) continue;
    if (candidateRoute.fingerprintKey) usedFingerprints.add(candidateRoute.fingerprintKey);
    try {
      const result = await chatWithRetry(
        resolved.provider,
        messages,
        routeOptions(freeRouteOptions(resolved, options, candidate, config), candidateRoute),
        attempts,
      );
      if (failedRoutes > 0) {
        options.onEvent?.({ type: "provider-fallback", model: candidate.alias });
      }
      return result;
    } catch (error) {
      failedRoutes++;
      error.resolvedModel = candidate.alias;
      error.totalAttempts = (error.totalAttempts || 0) + Number(error.attempts || 1);
    }
  }
  try {
    const legacyRoute = resolveRoute("auto-free", config);
    return await chatWithRetry(
      legacy.provider,
      messages,
      routeOptions(options, legacyRoute),
      attempts,
    );
  } catch (error) {
    if (canRetryAutoFreeAnonymously(legacy, error)) {
      return chatWithRetry(anonymousProvider(legacy), messages, options, 1);
    }
    throw error;
  }
}
function buildRouteOptions(resolved, alias, requestOptions, capabilities, settings, route) {
  return routeOptions(openCodeRequestOptions(resolved, {
    ...requestOptions,
    model: resolved.model,
    capabilities,
    parallelToolCalls: capabilities.supportsParallelTools && settings.parallelToolCalls,
    reasoningEffort: capabilities.supportsReasoningEffort ? requestOptions.reasoningEffort : undefined,
    temperature: capabilities.supportsTemperature ? requestOptions.temperature : undefined,
    topP: capabilities.supportsTopP ? requestOptions.topP : undefined,
    maxTokens: capabilities.supportsMaxTokens ? requestOptions.maxTokens : undefined,
  }), route);
}
export async function chat(messages, opts = {}) {
  const {
    config: configOverride,
    maxProviderAttempts,
    ...requestOptions
  } = opts;
  const config = configOverride || loadConfig();
  const alias = String(requestOptions.model || config.model || "big-cock");
  const route = resolveRoute(alias, config);
  const resolved = resolveProvider(alias, config);
  const settings = resolveEffectiveSettings(resolved.requested || alias, { config });
  const capabilities = resolveProviderCapabilities(
    resolved.exactID || alias,
    resolved.definition,
  );
  const options = buildRouteOptions(resolved, alias, requestOptions, capabilities, settings, route);
  const configuredAttempts = Number(maxProviderAttempts ?? settings.maxProviderRetries);
  const attempts = configuredAttempts > 0 ? configuredAttempts : 1;
  const contextLimit = Number(settings.contextLimit || route.capabilities?.contextLimit || 0) || null;
  if (contextLimit) {
    if (Number.isFinite(Number(requestOptions.projectedTokens))) {
      options.projectedTokens = Math.max(0, Number(requestOptions.projectedTokens));
    } else {
      const preflight = preflightContext({
        messages,
        tools: options.tools || [],
        options,
        capabilities,
        contextLimit,
        adapter: resolved.provider?.adapter || null,
      });
      options.projectedTokens = preflight.projectedTokens;
    }
  }
  if (resolved.id === "auto-free") {
    return chatWithFreeRoutes(messages, options, attempts, config, resolved);
  }
  try {
    return await chatWithRetry(resolved.provider, messages, options, attempts);
  } catch (error) {
    error.resolvedModel = alias;
    error.totalAttempts = Number(error.attempts || 1);
    if (canRetryOpenCodeAnonymously(resolved, error)) {
      return chatWithRetry(anonymousProvider(resolved), messages, options, attempts);
    }
    if (canRetryAutoFreeAnonymously(resolved, error)) {
      return chatWithRetry(anonymousProvider(resolved), messages, options, 1);
    }
    if (
      config.providerFallback === true
      && config.fallbackModel
      && String(config.fallbackModel) !== alias
      && isFallbackEligibleFailure(error.failureClass)
    ) {
      const fallbackRoute = selectFallback({
        alias,
        config,
        requirements: {
          supportsTools: (options.tools?.length || 0) > 0,
          supportsReasoning: Boolean(options.reasoningEffort),
        },
        usedFingerprints: new Set([route.fingerprintKey, error.routeFingerprintKey].filter(Boolean)),
      });
      if (fallbackRoute) {
        const fallback = resolveProvider(fallbackRoute.alias, config);
        const fallbackSettings = resolveEffectiveSettings(fallbackRoute.alias, { config });
        const fallbackCapabilities = resolveProviderCapabilities(fallbackRoute.alias, fallback.definition);
        if (options.tools?.length && fallbackCapabilities.supportsToolCalling === false) throw error;
        requestOptions.onEvent?.({ type: "provider-fallback", model: fallbackRoute.alias });
        const fallbackOptions = routeOptions(openCodeRequestOptions(fallback, {
          ...requestOptions,
          model: fallback.model,
          capabilities: fallbackCapabilities,
          requestId: providerAttemptId("", 1),
          parallelToolCalls: fallbackCapabilities.supportsParallelTools
            && fallbackSettings.parallelToolCalls,
          reasoningEffort: fallbackCapabilities.supportsReasoningEffort ? requestOptions.reasoningEffort : undefined,
          temperature: fallbackCapabilities.supportsTemperature ? requestOptions.temperature : undefined,
          topP: fallbackCapabilities.supportsTopP ? requestOptions.topP : undefined,
          maxTokens: fallbackCapabilities.supportsMaxTokens ? requestOptions.maxTokens : undefined,
        }), fallbackRoute);
        const fallbackAttempts = Math.max(
          1,
          Number(maxProviderAttempts ?? fallbackSettings.maxProviderRetries) || 1,
        );
        try {
          return await chatWithRetry(fallback.provider, messages, fallbackOptions, fallbackAttempts);
        } catch (fallbackError) {
          fallbackError.resolvedModel = fallbackRoute.alias;
          fallbackError.totalAttempts = Number(error.totalAttempts || 1) + Number(fallbackError.attempts || 1);
          throw fallbackError;
        }
      }
    }
    throw error;
  }
}
export function estimateProviderPayload(messages, tools = [], model = "big-cock", config = null) {
  const resolvedConfig = config || loadConfig();
  const resolved = resolveProvider(model, resolvedConfig);
  const adapter = resolved.provider?.adapter || null;
  const route = resolveRoute(model, resolvedConfig);
  const capabilities = resolveProviderCapabilities(
    resolved.exactID || model,
    resolved.definition,
  );
  let tokens = 0;
  try {
    if (adapter) {
      tokens += countTokens(JSON.stringify(adapter.normalizeMessages(messages, capabilities)));
      tokens += countTokens(JSON.stringify(adapter.normalizeTools(tools, capabilities)));
    } else {
      tokens += countTokens(JSON.stringify(messages || []));
      tokens += countTokens(JSON.stringify(tools || []));
    }
  } catch {
    tokens = countTokens(JSON.stringify(messages || [])) + countTokens(JSON.stringify(tools || []));
  }
  const contextLimit = Number(route.capabilities?.contextLimit || 0) || null;
  return { tokens, contextLimit, model, alias: route.alias, routeId: route.routeId };
}
export { listModels } from "./provider-models.js";
