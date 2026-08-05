import { loadConfig } from "../config/index.js";
import { getProviderCredential } from "./auth.js";
import { CodexResponsesProvider } from "./codex-provider.js";
import { OpenAICompatibleProvider } from "./providers.js";

export async function listModels(providerId) {
  const config = loadConfig();
  if (providerId === "opencode") return ["big-pickle"];
  if (providerId === "codex") return new CodexResponsesProvider().listModels();
  if (providerId === "mistral") return ["vibe"];
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
