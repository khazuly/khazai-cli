import { removeProvider } from "../config/index.js";
import { removeProviderCredential, saveProviderCredential } from "../lib/auth.js";
import {
  QWEN_CLOUD_BASE_URL,
  QWEN_CLOUD_ID,
  QWEN_CLOUD_NAME,
  clearQwenCloudClient,
  validateQwenCloudConnection,
} from "../lib/qwen-cloud.js";
import { redactSecrets } from "../lib/secrets.js";
import { nextId } from "./session-runtime.js";

function failureReason(error) {
  return redactSecrets(String(error?.message || "the provider could not be reached"))
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

async function connectQwenCloud(context) {
  const { appendArchived, requestValue, saveProvider } = context;
  const validateConnection = context.validateQwenCloudConnection || validateQwenCloudConnection;
  const persistCredential = context.saveProviderCredential || saveProviderCredential;
  const apiKey = await requestValue("Connect Qwen Cloud\n\nAPI Key", [], { secret: true });
  if (!apiKey?.trim()) {
    appendArchived({ id: nextId(), type: "error", content: "Qwen Cloud connection failed: an API key is required" });
    return;
  }
  try {
    const models = await validateConnection({ apiKey });
    saveProvider(QWEN_CLOUD_ID, {
      type: "openai-compatible",
      baseURL: QWEN_CLOUD_BASE_URL,
      env: "DASHSCOPE_API_KEY",
      models,
    });
    persistCredential(QWEN_CLOUD_ID, apiKey);
    clearQwenCloudClient();
    appendArchived({ id: nextId(), type: "answer", content: "Qwen Cloud connected." });
  } catch (error) {
    appendArchived({ id: nextId(), type: "error", content: `Qwen Cloud connection failed: ${failureReason(error)}` });
  }
}

async function connectCustomProvider(context) {
  const { appendArchived, listModels, requestValue, saveProvider } = context;
  const customID = await requestValue("Provider ID");
  if (!customID) return;
  const baseURL = await requestValue("OpenAI-compatible base URL");
  if (!/^https?:\/\//i.test(baseURL)) throw new Error("The provider base URL must use HTTP or HTTPS.");
  const env = `${customID.replace(/[^a-z0-9]/gi, "_").toUpperCase()}_API_KEY`;
  const apiKey = await requestValue("API key", [], { secret: true });
  saveProvider(customID, { type: "openai-compatible", baseURL, env, models: [] });
  if (apiKey) saveProviderCredential(customID, apiKey);
  let models = [];
  try { models = await listModels(customID); } catch {}
  if (models.length === 0) {
    const manual = await requestValue("Model ID");
    if (manual) models = [manual];
  }
  saveProvider(customID, { type: "openai-compatible", baseURL, env, models });
  appendArchived({
    id: nextId(),
    type: "answer",
    content: `Connected provider ${customID}${models.length ? ` with ${models.length} model${models.length === 1 ? "" : "s"}` : ""}.`,
  });
}

export async function connectProvider(arg, context) {
  const { appendArchived, loginCodex, listModels, requestValue, saveProvider } = context;
  try {
    const provider = String(arg || await requestValue(
      "Select a provider",
      [QWEN_CLOUD_NAME, "Codex · ChatGPT OAuth", "Custom OpenAI-compatible"],
      { values: [
        { label: QWEN_CLOUD_NAME, value: QWEN_CLOUD_ID },
        { label: "Codex · ChatGPT OAuth", value: "codex" },
        { label: "Custom OpenAI-compatible", value: "custom" },
      ] },
    )).toLowerCase();
    if (!provider) return;
    if (provider === QWEN_CLOUD_ID) return connectQwenCloud(context);
    if (provider === "codex") {
      await loginCodex({
        onAuthorize: url => appendArchived({
          id: nextId(), type: "answer", content: `Open this URL to connect Codex:\n${url}`,
        }),
      });
      const models = await listModels("codex");
      if (models.length === 0) throw new Error("Codex did not return any models for this account.");
      saveProvider("codex", { type: "codex-responses", models });
      const selected = await requestValue("Select a Codex model", models, {
        values: models.map(model => ({ label: model, value: model })),
      });
      if (selected) await context.chooseModel(`codex/${selected}`);
      return;
    }
    if (provider === "custom") return connectCustomProvider(context);
    throw new Error(`Unknown provider "${provider}".`);
  } catch (error) {
    appendArchived({ id: nextId(), type: "error", content: failureReason(error) });
  }
}

export async function manageProviderConnections(arg, context) {
  const { appendArchived, requestValue } = context;
  const [provider = "", action = ""] = String(arg || "").trim().toLowerCase().split(/\s+/);
  if (provider && provider !== QWEN_CLOUD_ID) {
    appendArchived({ id: nextId(), type: "error", content: `Unknown provider "${provider}".` });
    return;
  }
  if (!context.loadConfig().providers?.[QWEN_CLOUD_ID]) {
    appendArchived({ id: nextId(), type: "answer", content: "Qwen Cloud is not connected." });
    return;
  }
  const selectedAction = action || await requestValue("Qwen Cloud · Connected", ["Update API key", "Disconnect"], {
    values: [{ label: "Update API key", value: "update" }, { label: "Disconnect", value: "disconnect" }],
  });
  if (selectedAction === "update") return connectQwenCloud(context);
  if (selectedAction !== "disconnect") return;
  removeProviderCredential(QWEN_CLOUD_ID);
  removeProvider(QWEN_CLOUD_ID);
  clearQwenCloudClient();
  appendArchived({ id: nextId(), type: "answer", content: "Qwen Cloud disconnected." });
}
