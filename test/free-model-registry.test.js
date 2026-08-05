import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, configuredModels } from "../config/index.js";
import {
  KHAZAI_FREE_MODEL_CATEGORY,
  KHAZAI_FREE_UPSTREAM_BASE_URL,
  sanitizePublicBranding,
  stealthModelDisplayName,
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
import { chat, resolveModelDescriptor } from "../lib/llm.js";
import {
  formatModelStatusList,
  modelDetails,
} from "../ui/model-command.js";

const CHAT_ENDPOINT = `${KHAZAI_FREE_UPSTREAM_BASE_URL}/chat/completions`;
const FREE_ALIASES = ["big-cock", "boboiboy", "komodo", "ombak", "petir", "kutub", "mecha", "auto-free"];

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

test("All configured aliases appear in /model free", async () => {
  const originalFetch = globalThis.fetch;
  resetZenCatalog();
  resetProviderHealth();
  globalThis.fetch = async () => jsonListResponse(zenModels().map(model => model.upstreamModel).filter(Boolean));
  try {
    await refreshZenAvailability({ force: true });
    const list = modelStatusList();
    const output = formatModelStatusList(list);
    assert.match(output, new RegExp(KHAZAI_FREE_MODEL_CATEGORY));
    for (const alias of FREE_ALIASES) {
      assert.match(output, new RegExp(`\\b${alias}\\b`), `${alias} must appear in /model free`);
    }
    assert.match(output, /auto-free/);
    assert.doesNotMatch(output, /\bAvailable\b/);
    assert.equal(list.length, FREE_ALIASES.length);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Temporary HTTP 429 does not remove an alias", async () => {
  resetZenCatalog();
  resetProviderHealth();
  recordRouteFailure("khazai-free", "deepseek-v4-flash-free", CHAT_ENDPOINT, "rate_limited");
  const list = modelStatusList();
  assert.ok(list.some(model => model.alias === "boboiboy"), "boboiboy stays in the registry after 429");
  assert.ok(list.every(model => ["routing", "unknown", "cooldown"].includes(model.status)));
});

test("HTTP 500 marks a route unhealthy without deleting it", async () => {
  resetZenCatalog();
  resetProviderHealth();
  for (let index = 0; index < FAILURE_THRESHOLD; index += 1) {
    recordRouteFailure("khazai-free", "deepseek-v4-flash-free", CHAT_ENDPOINT, "provider_infrastructure");
  }
  const list = modelStatusList();
  const boboiboy = list.find(model => model.alias === "boboiboy");
  assert.ok(boboiboy, "boboiboy is not deleted after repeated HTTP 500");
  assert.equal(boboiboy.status, "unhealthy");
  assert.equal(list.length, FREE_ALIASES.length);
});

test("Failed discovery preserves the static registry", async () => {
  const originalFetch = globalThis.fetch;
  resetZenCatalog();
  resetProviderHealth();
  globalThis.fetch = async () => { throw new Error("network unreachable"); };
  try {
    await refreshZenAvailability({ force: true });
    const list = modelStatusList();
    assert.equal(list.length, FREE_ALIASES.length, "static registry is preserved when discovery fails");
    assert.ok(list.every(model => model.status === "unknown" || model.status === "routing"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Existing sessions using boboiboy resume correctly", async () => {
  resetZenCatalog();
  resetProviderHealth();
  const descriptor = resolveModelDescriptor("boboiboy");
  assert.equal(descriptor.providerID, "khazai-free");
  assert.equal(descriptor.exactID, "boboiboy");
  assert.equal(stealthModelDisplayName("boboiboy"), "Boboiboy");
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

test("Model settings remain attached to the correct alias after migration", () => {
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
  assert.deepEqual(migrated.modelSettings.boboiboy, {
    temperature: 0.9,
    maxOutputTokens: 1024,
    contextLimit: 16_000,
    compactThreshold: 0.8,
    retries: 2,
    reasoningEffort: "high",
    tools: false,
  }, "legacy settings merge into one canonical alias entry");
  assert.ok(!migrated.modelSettings["opencode-zen/deepseek-v4-flash-free"], "no duplicate entry remains");
  assert.deepEqual(migrated.models.kutub, { contextLimit: 5000 });
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
    "all eligible free aliases return after the cooldown expires",
  );
});

test("Upstream names do not appear in normal UI", async () => {
  await withDiscovery(
    zenModels().map(model => model.upstreamModel).filter(Boolean),
    async () => {
      const free = formatModelStatusList(modelStatusList());
      const details = await modelDetails("boboiboy");
      for (const alias of FREE_ALIASES) assert.match(free, new RegExp(`\\b${alias}\\b`));
      for (const model of zenModels()) {
        if (!model.upstreamModel) continue;
        assert.doesNotMatch(free, new RegExp(model.upstreamModel, "i"));
        assert.doesNotMatch(details, new RegExp(model.upstreamModel, "i"));
        assert.equal(sanitizePublicBranding(model.upstreamModel), model.alias);
      }
      assert.match(details, /Model\s+Boboiboy/);
      assert.match(details, /Provider\s+KhazAI/);
      assert.doesNotMatch(details, /\bAvailable\b/);
      assert.match(details, /Context\s+Unknown/);
      assert.doesNotMatch(details, /opencode|zen\//i);
    },
  );
});

test("Refresh updates status without removing aliases", async () => {
  const originalFetch = globalThis.fetch;
  resetZenCatalog();
  resetProviderHealth();
  const upstream = zenModels().map(model => model.upstreamModel).filter(Boolean);
  const subset = upstream.slice(0, 4);
  globalThis.fetch = async () => jsonListResponse(subset);
  try {
    await refreshZenAvailability({ force: true });
    const after = modelStatusList();
    assert.equal(after.length, FREE_ALIASES.length);
    assert.equal(after.filter(model => model.status === "available").length, 4);
    assert.equal(after.filter(model => model.status === "unavailable").length, 3);
    assert.ok(after.find(model => model.alias === "kutub").status === "unavailable");
    globalThis.fetch = async () => jsonListResponse(upstream);
    await refreshZenAvailability({ force: true });
    const refreshed = modelStatusList();
    assert.equal(refreshed.length, FREE_ALIASES.length);
    assert.ok(refreshed.every(model => model.status === "available" || model.status === "routing"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Restart preserves the complete free-model list", async () => {
  resetZenCatalog();
  resetProviderHealth();
  const firstBoot = zenModels(loadConfig()).map(model => model.alias);
  assert.deepEqual(firstBoot, FREE_ALIASES);
  const config = loadConfig();
  const leading = [
    ...zenModels(config).filter(model => model.alias !== "auto-free").map(model => model.alias),
    "auto-free",
  ];
  assert.deepEqual(configuredModels().filter(model => model !== "vibe").slice(0, leading.length), leading);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("discovery down at restart"); };
  try {
    await refreshZenAvailability({ force: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const secondBoot = zenModels(loadConfig()).map(model => model.alias);
  assert.deepEqual(secondBoot, FREE_ALIASES, "restart keeps every free alias");
});

test("Selecting an unavailable model reports its status instead of removing it", async () => {
  resetZenCatalog();
  resetProviderHealth();
  recordRouteFailure("khazai-free", "north-mini-code-free", CHAT_ENDPOINT, "provider_infrastructure");
  const list = modelStatusList();
  const kutub = list.find(model => model.alias === "kutub");
  assert.ok(kutub, "kutub remains listed while temporarily unavailable");
  assert.equal(kutub.status, "cooldown");
});
