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

function isTransientProviderError(error) {
  return /^HTTP (?:500|502|503|504):/.test(String(error?.message || error));
}

async function chatWithRetry(provider, messages, options, attempts = 3) {
  let error;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await provider.chat(messages, options);
    } catch (caught) {
      error = caught;
      if (!isTransientProviderError(error) || attempt === attempts - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
    }
  }
  throw error;
}

export async function chat(messages, opts = {}) {
  const resolved = resolveProvider(opts.model);
  const options = { ...opts, model: resolved.model };
  const attempts = resolved.id === "auto-free" ? 1 : 5;
  try {
    return await chatWithRetry(resolved.provider, messages, options, attempts);
  } catch (error) {
    if (!canRetryAutoFreeAnonymously(resolved, error)) throw error;
    const provider = new OpenAICompatibleProvider({
      id: resolved.id,
      baseURL: resolved.definition.baseURL,
      headers: resolved.definition.headers || {},
    });
    return chatWithRetry(provider, messages, options);
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
