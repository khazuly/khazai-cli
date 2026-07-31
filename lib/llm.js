import { loadConfig } from "../config/index.js";
import { resolveEffectiveSettings, resolveProviderCapabilities } from "../config/model-settings.js";
import { getOpenCodeCredential, getProviderCredential } from "./auth.js";
import { CodexResponsesProvider } from "./codex-provider.js";
import { mergeToolCallDelta, OpenAICompatibleProvider } from "./providers.js";
import {
  classifyProviderFailure,
  debugProviderDiagnostic,
  isFallbackEligibleFailure,
  isRetryableFailure,
  plainRouteHealthy,
  providerAttemptId,
  providerDiagnostic,
  recordRouteFailure,
  recordRouteSuccess,
  routeAvailability,
} from "./provider-reliability.js";
import {
  KHAZAI_FREE_UPSTREAM_BASE_URL,
  resolveZenModel,
} from "../config/khazai-free-models.js";
import { zenRouteCandidates } from "./khazai-free-model-catalog.js";

export { mergeToolCallDelta };

export function resolveModelDescriptor(model, config = loadConfig()) {
  const requested = String(model || config.model || "big-cock");
  if (["big-cock", "cock"].includes(requested.toLowerCase())) {
    return {
      requested,
      providerID: "opencode",
      modelID: "big-pickle",
      exactID: "opencode/big-pickle",
      definition: {
        baseURL: "https://opencode.ai/zen/v1",
        env: "OPENCODE_API_KEY",
        headers: {},
      },
    };
  }
  if (requested.toLowerCase() === "auto-free") {
    return {
      requested,
      providerID: "auto-free",
      modelID: "kilo-auto/free",
      exactID: "auto-free",
      definition: {
        baseURL: "https://api.kilo.ai/api/gateway",
        env: "KILO_API_KEY",
        headers: {},
      },
    };
  }
  const freeModel = resolveZenModel(requested, config);
  if (freeModel?.upstreamModel) {
    return {
      requested,
      providerID: "khazai-free",
      modelID: freeModel.upstreamModel,
      exactID: freeModel.alias,
      definition: {
        baseURL: KHAZAI_FREE_UPSTREAM_BASE_URL,
        env: "OPENCODE_API_KEY",
        headers: {},
        capabilities: freeModel.capabilities,
        displayName: freeModel.displayName,
      },
    };
  }
  if (requested.toLowerCase().startsWith("codex/")) {
    const modelID = requested.slice(requested.indexOf("/") + 1);
    if (!modelID) throw new Error('Unknown Codex model. Use codex/model.');
    return {
      requested,
      providerID: "codex",
      modelID,
      exactID: `codex/${modelID}`,
      definition: { protocol: "codex-responses" },
    };
  }

  const separator = requested.indexOf("/");
  if (separator < 1) {
    throw new Error(`Model "${requested}" is unavailable. Select another model with /model.`);
  }
  const providerID = requested.slice(0, separator);
  const modelID = requested.slice(separator + 1);
  const definition = config.providers?.[providerID];
  if (!definition) {
    throw new Error(`Model "${requested}" is unavailable. Select another model with /model.`);
  }
  return { requested, providerID, modelID, exactID: requested, definition };
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

export async function chatWithRetry(provider, messages, options, attempts = 3) {
  let error;
  const retryLog = [];
  const maximumAttempts = Math.max(1, Number(attempts) || 1);
  const endpoint = provider.chatURL?.() || provider.endpoint || "";
  const toolCount = options.tools?.length || 0;
  const availability = endpoint && !options.bypassProviderHealth
    ? routeAvailability(provider.id, options.model, endpoint, toolCount)
    : { available: true };
  if (!availability.available) {
    error = new Error("The resolved model route is temporarily unavailable.");
    error.failureClass = availability.failureClass;
    error.endpoint = endpoint;
    error.attempts = 0;
    throw error;
  }
  for (let attempt = 0; attempt < maximumAttempts; attempt++) {
    if (!activeRequest(options)) throw options.signal?.reason || new Error("Cancelled");
    const requestId = providerAttemptId(options.requestId, attempt);
    const scopedOptions = attemptOptions(options, requestId);
    const callbacks = attemptCallbacks(scopedOptions);
    try {
      const attemptOptions = provider.retryOptions?.(callbacks.options, attempt) || callbacks.options;
      const result = await provider.chat(messages, attemptOptions);
      if (!activeRequest(scopedOptions)) throw options.signal?.reason || new Error("Cancelled");
      if (endpoint) recordRouteSuccess(provider.id, scopedOptions.model, endpoint, toolCount);
      callbacks.publish();
      return result;
    } catch (caught) {
      error = caught;
      error.attempts = attempt + 1;
      if (!activeRequest(scopedOptions)) {
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
        scopedOptions,
        error,
        attempt + 1,
        failureClass,
        delayMs,
      );
      retryLog.push(diagnostic);
      debugProviderDiagnostic(diagnostic);
      if (endpoint) {
        recordRouteFailure(provider.id, scopedOptions.model, endpoint, failureClass, toolCount);
      }
      if (!isRetryableFailure(failureClass) || attempt === maximumAttempts - 1) {
        error.retryLog = retryLog;
        throw error;
      }
      if (!activeRequest(scopedOptions)) throw options.signal?.reason || new Error("Cancelled");
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
  let failedRoutes = 0;
  for (const candidate of candidates) {
    const resolved = resolveProvider(candidate.alias, config);
    try {
      const result = await chatWithRetry(
        resolved.provider,
        messages,
        freeRouteOptions(resolved, options, candidate, config),
        attempts,
      );
      if (failedRoutes > 0) {
        options.onEvent?.({ type: "provider-fallback", model: candidate.alias });
      }
      return result;
    } catch (error) {
      failedRoutes++;
      error.resolvedModel = candidate.alias;
    }
  }
  try {
    return await chatWithRetry(legacy.provider, messages, options, attempts);
  } catch (error) {
    if (canRetryAutoFreeAnonymously(legacy, error)) {
      return chatWithRetry(anonymousProvider(legacy), messages, options, 1);
    }
    throw error;
  }
}

export async function chat(messages, opts = {}) {
  const {
    config: configOverride,
    maxProviderAttempts,
    ...requestOptions
  } = opts;
  const config = configOverride || loadConfig();
  const resolved = resolveProvider(requestOptions.model, config);
  const settings = resolveEffectiveSettings(resolved.requested || requestOptions.model, { config });
  const capabilities = resolveProviderCapabilities(
    resolved.exactID || requestOptions.model,
    resolved.definition,
  );
  const options = openCodeRequestOptions(resolved, {
    ...requestOptions,
    model: resolved.model,
    capabilities,
    parallelToolCalls: capabilities.supportsParallelTools && settings.parallelToolCalls,
    reasoningEffort: capabilities.supportsReasoningEffort ? requestOptions.reasoningEffort : undefined,
    temperature: capabilities.supportsTemperature ? requestOptions.temperature : undefined,
    topP: capabilities.supportsTopP ? requestOptions.topP : undefined,
    maxTokens: capabilities.supportsMaxTokens ? requestOptions.maxTokens : undefined,
  });
  const configuredAttempts = Number(maxProviderAttempts ?? settings.maxProviderRetries);
  const attempts = configuredAttempts > 0 ? configuredAttempts : 1;
  if (resolved.id === "auto-free") {
    return chatWithFreeRoutes(messages, options, attempts, config, resolved);
  }
  try {
    return await chatWithRetry(resolved.provider, messages, options, attempts);
  } catch (error) {
    if (canRetryOpenCodeAnonymously(resolved, error)) {
      return chatWithRetry(anonymousProvider(resolved), messages, options, attempts);
    }
    if (canRetryAutoFreeAnonymously(resolved, error)) {
      return chatWithRetry(anonymousProvider(resolved), messages, options, 1);
    }
    if (
      config.providerFallback === true
      && config.fallbackModel
      && config.fallbackModel !== requestOptions.model
      && isFallbackEligibleFailure(error.failureClass)
    ) {
      const fallback = resolveProvider(config.fallbackModel, config);
      const fallbackSettings = resolveEffectiveSettings(config.fallbackModel, { config });
      const fallbackCapabilities = resolveProviderCapabilities(config.fallbackModel, fallback.definition);
      if (options.tools?.length && !fallbackCapabilities.supportsToolCalling) throw error;
      requestOptions.onEvent?.({ type: "provider-fallback", model: config.fallbackModel });
      debugProviderDiagnostic({
        provider: fallback.id,
        model: fallback.model,
        failureClass: "fallback_selected",
        attempt: 0,
      });
      const fallbackOptions = openCodeRequestOptions(fallback, {
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
      });
      const fallbackAttempts = Math.max(
        1,
        Number(maxProviderAttempts ?? fallbackSettings.maxProviderRetries) || 1,
      );
      try {
        return await chatWithRetry(fallback.provider, messages, fallbackOptions, fallbackAttempts);
      } catch (fallbackError) {
        fallbackError.resolvedModel = config.fallbackModel;
        throw fallbackError;
      }
    }
    throw error;
  }
}

export async function listModels(providerId) {
  const config = loadConfig();
  if (providerId === "opencode") return ["big-pickle"];
  if (providerId === "codex") return new CodexResponsesProvider().listModels();
  const definition = config.providers?.[providerId];
  if (!definition) throw new Error(`Provider "${providerId}" is not configured.`);
  const provider = new OpenAICompatibleProvider({
    id: providerId,
    baseURL: definition.baseURL,
    apiKey: getProviderCredential(providerId, definition.env),
    headers: definition.headers || {},
  });
  return provider.listModels();
}

export async function ensureSession() {}
export async function resetSession() {}
