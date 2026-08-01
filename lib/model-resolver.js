import { loadConfig } from "../config/index.js";
import {
  KHAZAI_FREE_UPSTREAM_BASE_URL,
  KHAZAI_ROTATING_PROVIDER_ID,
  KHAZAI_ROTATING_UPSTREAM_BASE_URL,
  KHAZAI_ROTATING_UPSTREAM_ORIGIN,
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
    const rotatingTransport = freeModel.provider === KHAZAI_ROTATING_PROVIDER_ID;
    return {
      requested,
      providerID: rotatingTransport ? KHAZAI_ROTATING_PROVIDER_ID : "khazai-free",
      modelID: freeModel.upstreamModel,
      exactID: freeModel.alias,
      definition: {
        baseURL: rotatingTransport ? KHAZAI_ROTATING_UPSTREAM_BASE_URL : KHAZAI_FREE_UPSTREAM_BASE_URL,
        env: rotatingTransport ? "" : "OPENCODE_API_KEY",
        headers: rotatingTransport
          ? { Origin: KHAZAI_ROTATING_UPSTREAM_ORIGIN, Referer: `${KHAZAI_ROTATING_UPSTREAM_ORIGIN}/` }
          : {},
        capabilities: freeModel.capabilities,
        compatibility: rotatingTransport ? { toolProtocol: "prompt-json" } : {},
        displayName: freeModel.displayName,
        rotatingTransport,
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
