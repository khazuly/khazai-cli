import { loadConfig } from "../config/index.js";
import {
  KHAZAI_FREE_UPSTREAM_BASE_URL,
  resolveZenModel,
} from "../config/khazai-free-models.js";
import { findQwenCloudModel, QWEN_CLOUD_ID } from "./qwen-cloud.js";


export function resolveModelDescriptor(model, config = loadConfig()) {
  const requested = String(model || config.model || "auto-free");
  if (["big-cock", "cock"].includes(requested.toLowerCase())) {
    return {
      requested,
      providerID: "opencode",
      modelID: "big-pickle",
      exactID: "opencode/big-pickle",
      definition: {
        baseURL: KHAZAI_FREE_UPSTREAM_BASE_URL,
        env: "OPENCODE_API_KEY",
        headers: {},
        family: "unknown",
        promptProfile: "big-cock",
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
        promptProfile: "big-cock",
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
          parallelTools: true,
          toolChoice: false,
          reasoningEffort: false,
        },
      },
    };
  }
  if (requested === "aichat/claude-haiku-4-5") {
    return {
      requested,
      providerID: "aichat",
      modelID: "anthropic/claude-haiku-4-5",
      exactID: "aichat/claude-haiku-4-5",
      definition: {
        baseURL: "https://aichat.org",
        family: "anthropic",
        promptProfile: "bug-bounty",
        capabilities: {
          streaming: true,
          tools: true,
          contextLimit: null,
          temperature: false,
          topP: false,
          maxOutputTokens: false,
          parallelTools: true,
          toolChoice: false,
          reasoningEffort: false,
        },
      },
    };
  }
  if (["gemini/3.5-flash", "3.5-flash", "gemini-guest", "gemini/3.5-flash-lite", "3.5-flash-lite"].includes(requested.toLowerCase())) {
    return {
      requested,
      providerID: "gemini-guest",
      modelID: "3.5-flash",
      exactID: "gemini/3.5-flash",
      definition: {
        baseURL: "https://gemini.google.com",
        family: "gemini",
        promptProfile: "default",
        displayName: "Gemini 3.5 Flash",
        capabilities: {
          streaming: false,
          tools: true,
          contextLimit: null,
          temperature: false,
          topP: false,
          maxOutputTokens: false,
          parallelTools: true,
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
      exactID: freeModel.key,
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

  const qwen = findQwenCloudModel(requested, config.providers?.[QWEN_CLOUD_ID]?.models);
  if (qwen && config.providers?.[QWEN_CLOUD_ID]) {
    return {
      requested,
      providerID: QWEN_CLOUD_ID,
      modelID: qwen.upstreamModelId,
      exactID: qwen.publicName,
      definition: {
        ...config.providers[QWEN_CLOUD_ID],
        family: qwen.family,
        promptProfile: qwen.promptProfile,
        contextLimit: qwen.contextLimit,
        capabilities: qwen.capabilities,
        displayName: qwen.publicName,
      },
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
