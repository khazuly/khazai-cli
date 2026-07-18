import { loadConfig } from "../config/index.js";
import { getProviderCredential } from "./auth.js";
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
  return {
    provider: new OpenAICompatibleProvider({
      id: descriptor.providerID,
      baseURL: descriptor.definition.baseURL,
      apiKey: getProviderCredential(descriptor.providerID, descriptor.definition.env),
      headers: descriptor.definition.headers || {},
    }),
    model: descriptor.modelID,
    id: descriptor.providerID,
  };
}

export async function chat(messages, opts = {}) {
  const resolved = resolveProvider(opts.model);
  return resolved.provider.chat(messages, { ...opts, model: resolved.model });
}

export async function listModels(providerId) {
  const config = loadConfig();
  if (providerId === "opencode") return ["big-pickle"];
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
