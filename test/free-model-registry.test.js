import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, configuredModels } from "../config/index.js";
import {
  KHAZAI_FREE_MODEL_CATEGORY,
  KHAZAI_FREE_UPSTREAM_BASE_URL,
  sanitizePublicBranding,
  publicModelName,
  canonicalModelKey,
  zenModels,
} from "../config/khazai-free-models.js";
import { migrateModelSettings } from "../config/model-settings.js";
import {
  modelStatusList,
  refreshZenAvailability,
  resetZenCatalog,
  zenRouteCandidates,
} from "../lib/khazai-free-model-catalog.js";
import {
  FAILURE_THRESHOLD,
  recordRouteFailure,
  resetProviderHealth,
} from "../lib/provider-reliability.js";
import { canonicalizeSessionModelNames, migrateSessionV5 } from "../app/session-store.js";
import { chat, resolveModelDescriptor } from "../lib/llm.js";
import {
  formatModelStatusList,
  modelDetails,
} from "../ui/model-command.js";

const CHAT_ENDPOINT = `${KHAZAI_FREE_UPSTREAM_BASE_URL}/chat/completions`;
const FREE_MODELS = zenModels();
const FREE_KEYS = FREE_MODELS.map(model => model.key);

function jsonListResponse(ids) {
  return {
    ok: true,
    headers: { get: () => "application/json" },
    async json() { return { data: ids }; },
  };
}

function jsonChatResponse(content = "ok") {
  return {
    ok: true,
    headers: { get: () => "application/json" },
    async json() { return { choices: [{ message: { content } }] }; },
  };
}

function errorResponse(status, detail = '{"error":"temporary"}') {
  return {
    ok: false,
    status,
    statusText: "Temporary Error",
    headers: { get: name => name.toLowerCase() === "retry-after" ? "0" : null },
    async text() { return detail; },
  };
}

async function withDiscovery(ids, fn) {
  const originalFetch = globalThis.fetch;
  resetZenCatalog();
  resetProviderHealth();
  globalThis.fetch = async () => jsonListResponse(ids);
  try {
    await refreshZenAvailability({ force: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
  return fn();
}

test("All configured models appear in /model free under canonical names", async () => {
  const originalFetch = globalThis.fetch;
  resetZenCatalog();
  resetProviderHealth();
  globalThis.fetch = async () => jsonListResponse(zenModels().map(model => model.upstreamModel).filter(Boolean));
  try {
    await refreshZenAvailability({ force: true });
    const list = modelStatusList();
    const output = formatModelStatusList(list);
    assert.match(output, new RegExp(KHAZAI_FREE_MODEL_CATEGORY));
    for (const model of FREE_MODELS) {
      assert.match(output, new RegExp(escapeRegex(model.displayName)), `${model.displayName} must appear in /model free`);
    }
    assert.match(output, /Big Cock/);
    for (const alias of ["boboiboy", "komodo", "ombak", "petir", "kutub", "mecha"]) {
      assert.doesNotMatch(output, new RegExp(`\\b${alias}\\b`), `${alias} must not appear in /model free`);
    }
    assert.doesNotMatch(output, /opencode-zen|opencode\//i);
    assert.equal(list.length, FREE_KEYS.length, "static registry is preserved");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Static registry is preserved when discovery fails", async () => {
  const originalFetch = globalThis.fetch;
  resetZenCatalog();
  resetProviderHealth();
  globalThis.fetch = async () => ({ ok: false, status: 500, statusText: "boom" });
  try {
    await refreshZenAvailability({ force: true });
    const list = modelStatusList();
    assert.equal(list.length, FREE_KEYS.length, "static registry is preserved when discovery fails");
    assert.ok(list.every(model => model.status === "unknown" || model.status === "routing"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Existing sessions using stealth aliases resume correctly and report canonical names", async () => {
  resetZenCatalog();
  resetProviderHealth();
  const descriptor = resolveModelDescriptor("boboiboy");
  assert.equal(descriptor.providerID, "khazai-free");
  assert.equal(descriptor.exactID, "deepseek/deepseek-v4-flash-free");
  assert.equal(canonicalModelKey("boboiboy"), "deepseek/deepseek-v4-flash-free");
  assert.equal(publicModelName("komodo"), "mimo/mimo-v2.5-free");
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENCODE_API_KEY;
  delete process.env.OPENCODE_API_KEY;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return jsonChatResponse("resumed ok");
  };
  try {
    const result = await chat([{ role: "user", content: "continue the task" }], {
      model: "boboiboy",
      sessionId: "saved-session",
      runId: "saved-run",
    });
    assert.equal(result, "resumed ok");
    assert.equal(requests[0].url, `${KHAZAI_FREE_UPSTREAM_BASE_URL}/chat/completions`);
    assert.equal(requests[0].body.model, "deepseek-v4-flash-free");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = originalKey;
  }
});

test("Model settings remain attached to the correct canonical key after migration", () => {
  const config = loadConfig();
  const migrated = migrateModelSettings({
    ...config,
    model: "opencode/big-pickle",
    modelSettings: {
      "opencode-zen/deepseek-v4-flash-free": {
        temperature: 0.2,
        maxOutputTokens: 1024,
        contextLimit: 16_000,
        compactThreshold: 0.8,
        retries: 2,
        reasoningEffort: "high",
        tools: false,
      },
      "boboiboy": { temperature: 0.9 },
    },
    models: {
      "opencode/north-mini-code-free": { contextLimit: 5000 },
    },
  });
  assert.equal(migrated.model, "big-cock", "legacy active model name migrates to big-cock");
  assert.deepEqual(migrated.modelSettings["deepseek/deepseek-v4-flash-free"], {
    temperature: 0.9,
    maxOutputTokens: 1024,
    contextLimit: 16_000,
    compactThreshold: 0.8,
    retries: 2,
    reasoningEffort: "high",
    tools: false,
  }, "legacy settings merge into one canonical entry");
  assert.ok(!migrated.modelSettings["opencode-zen/deepseek-v4-flash-free"], "no duplicate entry remains");
  assert.deepEqual(migrated.models["north/north-mini-code-free"], { contextLimit: 5000 });
  assert.equal(Object.keys(migrated.modelSettings).length, 1);
});

test("auto-free restores all eligible routes after temporary failures", async () => {
  resetZenCatalog();
  resetProviderHealth();
  const config = {};
  const upstream = zenModels().map(model => model.upstreamModel).filter(Boolean);
  for (const id of upstream) {
    recordRouteFailure("khazai-free", id, CHAT_ENDPOINT, "provider_infrastructure");
  }
  assert.equal(zenRouteCandidates(config, {}, new Set()).length, 0, "all routes are skipped while unhealthy");
  const later = Date.now() + 120_000;
  const restored = zenRouteCandidates(config, {}, new Set(), later);
  const eligible = zenModels(config)
    .filter(model => model.provider === "khazai-free" && model.upstreamModel)
    .map(model => model.alias)
    .sort();
  assert.deepEqual(
    restored.map(candidate => candidate.alias).sort(),
    eligible,
    "auto-free restores all eligible routes after failures expire",
  );
});

test("modelDetails resolves by canonical key and display name", async () => {
  resetZenCatalog();
  resetProviderHealth();
  await withDiscovery([], async () => {
    const byKey = await modelDetails("deepseek/deepseek-v4-flash-free");
    assert.ok(byKey, "canonical key resolves");
    assert.match(byKey, /deepseek\/deepseek-v4-flash-free/);
    const byLegacy = await modelDetails("boboiboy");
    assert.ok(byLegacy, "legacy alias still resolves");
    assert.match(byLegacy, /deepseek\/deepseek-v4-flash-free/);
  });
});

test("sanitizePublicBranding hides upstream identifiers", () => {
  const output = sanitizePublicBranding("opencode-zen/deepseek-v4-flash-free and opencode/big-pickle");
  assert.match(output, /deepseek\/deepseek-v4-flash-free/);
  assert.doesNotMatch(output, /opencode-zen|opencode\//i);
});

test("stored sessions migrate stealth aliases to canonical names without losing context", () => {
  const legacy = {
    version: 5,
    id: "session-9",
    title: "Legacy",
    model: "boboiboy",
    agent: "build",
    workspace: "/tmp/ws",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    messages: [{ role: "user", content: "resume me" }],
    agentState: {
      model: "komodo",
      messages: [{ role: "assistant", content: "in progress" }],
      usage: { input: 42, output: 7 },
    },
    turns: [{ id: "t1", agentStateBefore: { model: "ombak" }, agentStateAfter: { model: "petir" } }],
  };
  const migrated = canonicalizeSessionModelNames(migrateSessionV5(legacy));
  assert.equal(migrated.model, "deepseek/deepseek-v4-flash-free");
  assert.equal(migrated.agentState.model, "mimo/mimo-v2.5-free");
  assert.equal(migrated.turns[0].agentStateBefore.model, "laguna/laguna-s-2.1-free");
  assert.equal(migrated.turns[0].agentStateAfter.model, "ling/ling-3.0-flash-free");
  assert.equal(migrated.id, "session-9");
  assert.equal(migrated.agent, "build");
  assert.equal(migrated.messages.length, 1);
  assert.deepEqual(migrated.agentState.usage, { input: 42, output: 7 });
});

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
