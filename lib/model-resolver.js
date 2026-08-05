import { loadConfig } from "../config/index.js";
import {
  KHAZAI_FREE_UPSTREAM_BASE_URL,
  resolveZenModel,
} from "../config/khazai-free-models.js";


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
        family: "unknown",
        promptProfile: "default",
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
        family: "unknown",
        promptProfile: "default",
      },
    };
  }
  if (requested === "vibe" || requested === "mistral/vibe") {
    return {
      requested,
      providerID: "mistral",
      modelID: "vibe",
      exactID: "mistral/vibe",
      definition: {
        baseURL: "https://chat.mistral.ai",
        env: "MISTRAL_COOKIE",
        headers: {},
        family: "mistral",
        promptProfile: "vibe",
        displayName: "Vibe",
        capabilities: {
          streaming: true,
          tools: true,
          reasoning: false,
          usage: false,
          contextLimit: null,
          temperature: true,
          topP: true,
          maxOutputTokens: true,
          parallelTools: false,
          toolChoice: false,
          reasoningEffort: false,
        },
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
    if (!modelID) throw new Error("Unknown Codex model. Use codex/model.");
    return {
      requested,
      providerID: "codex",
      modelID,
      exactID: `codex/${modelID}`,
      definition: { protocol: "codex-responses", family: "openai", promptProfile: "codex" },
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
