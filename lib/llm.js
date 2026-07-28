import { loadConfig } from "../config/index.js";
import { getOpenCodeCredential, getProviderCredential } from "./auth.js";
import { CodexResponsesProvider } from "./codex-provider.js";
import { mergeToolCallDelta, OpenAICompatibleProvider } from "./providers.js";

export { mergeToolCallDelta };

let _deepThinking = false;
export function setDeepThinking(_enabled) { _deepThinking = false; }
export function getDeepThinking() { return _deepThinking; }

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
      exactID: "auto-free/kilo-auto/free",
      definition: {
        baseURL: "https://api.kilo.ai/api/gateway",
        env: "KILO_API_KEY",
        headers: {},
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
  if (separator < 1) throw new Error(`Unknown model "${requested}". Use provider/model.`);
  const providerID = requested.slice(0, separator);
  const modelID = requested.slice(separator + 1);
  const definition = config.providers?.[providerID];
  if (!definition) throw new Error(`Provider "${providerID}" is not configured.`);
  return { requested, providerID, modelID, exactID: requested, definition };
}

export function resolveProvider(model, config = loadConfig()) {
  const descriptor = resolveModelDescriptor(model, config);
  if (descriptor.providerID === "codex") {
    return {
      provider: new CodexResponsesProvider({ model: descriptor.modelID }),
      model: descriptor.modelID,
      id: descriptor.providerID,
      apiKey: "",
      definition: descriptor.definition,
    };
  }
  const apiKey = getProviderCredential(descriptor.providerID, descriptor.definition.env)
    || (descriptor.providerID === "opencode" ? getOpenCodeCredential() : "");
  return {
    provider: new OpenAICompatibleProvider({
      id: descriptor.providerID,
      baseURL: descriptor.definition.baseURL,
      apiKey,
      headers: descriptor.definition.headers || {},
      rotateSessionAffinity: descriptor.providerID === "opencode",
    }),
    model: descriptor.modelID,
    id: descriptor.providerID,
    apiKey,
    definition: descriptor.definition,
  };
}

function canRetryAutoFreeAnonymously(resolved, error) {
  return resolved.id === "auto-free"
    && Boolean(resolved.apiKey)
    && /^HTTP 5\d\d:/.test(String(error?.message || error));
}

function openCodeRequestOptions(resolved, options) {
  if (resolved.id !== "opencode") return options;
  const sessionId = String(options.sessionId || options.turnId || "");
  const requestId = String(options.runId || "");
  return {
    ...options,
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
  if ([500, 502, 503, 504].includes(Number(error?.status))) return true;
  if (/^HTTP (?:500|502|503|504):/.test(String(error?.message || error))) return true;
  const code = String(error?.code || error?.cause?.code || "").toUpperCase();
  if (["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "PREMATURE_STREAM"].includes(code)) return true;
  return /connection reset|socket hang up|premature stream|stream ended before completion|terminated unexpectedly/i
    .test(String(error?.message || error));
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

function retryRecord(provider, options, error, attempt, retryDelayMs = null) {
  return {
    provider: provider.id || "unknown",
    model: options.model || "",
    requestId: error?.requestId || "",
    httpStatus: Number(error?.status) || null,
    attempt,
    retryDelayMs,
    streamPhase: error?.streamPhase || options.streamPhase || "request",
    runId: options.runId || "",
    turnId: options.turnId || "",
  };
}

export async function chatWithRetry(provider, messages, options, attempts = 3) {
  let error;
  const retryLog = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    const callbacks = attemptCallbacks(options);
    try {
      const attemptOptions = provider.retryOptions?.(callbacks.options, attempt) || callbacks.options;
      const result = await provider.chat(messages, attemptOptions);
      if (options.signal?.aborted) throw options.signal.reason || new Error("Cancelled");
      callbacks.publish();
      return result;
    } catch (caught) {
      error = caught;
      error.attempts = attempt + 1;
      if (options.signal?.aborted) {
        throw options.signal.reason || new Error("Cancelled");
      }
      if (!isTransientProviderError(error) || attempt === attempts - 1) {
        retryLog.push(retryRecord(provider, options, error, attempt + 1));
        error.retryLog = retryLog;
        throw error;
      }
      const delayMs = providerRetryDelay(error, attempt, options.retryRandom);
      retryLog.push(retryRecord(provider, options, error, attempt + 1, delayMs));
      await waitForRetry(options.signal, delayMs);
    }
  }
  throw error;
}

export async function chat(messages, opts = {}) {
  const resolved = resolveProvider(opts.model);
  const options = openCodeRequestOptions(resolved, { ...opts, model: resolved.model });
  const attempts = resolved.id === "auto-free" ? 1 : 3;
  try {
    return await chatWithRetry(resolved.provider, messages, options, attempts);
  } catch (error) {
    if (!canRetryAutoFreeAnonymously(resolved, error)) throw error;
    const provider = new OpenAICompatibleProvider({
      id: resolved.id,
      baseURL: resolved.definition.baseURL,
      headers: resolved.definition.headers || {},
    });
    return chatWithRetry(provider, messages, options, 1);
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
