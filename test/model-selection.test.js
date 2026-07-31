import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULTS } from "../config/defaults.js";
import { loadConfig, normalizeModel } from "../config/index.js";
import { chat, resolveModelDescriptor } from "../lib/llm.js";
import { COMMANDS, MODELS } from "../ui/commands.js";
import { MODEL_LABELS } from "../ui/components/banner.js";

test("Big Cock remains the default and all KhazAI free aliases are registered", () => {
  assert.equal(DEFAULTS.model, "big-cock");
  assert.equal(normalizeModel("gpt"), "big-cock");
  assert.equal(normalizeModel("local/qwen"), "local/qwen");
  assert.deepEqual(MODELS, [
    { name: "big-cock", description: "Big Cock (default)" },
    { name: "boboiboy", description: "Advanced reasoning and coding" },
    { name: "komodo", description: "Fast coding assistant" },
    { name: "ombak", description: "Balanced coding model" },
    { name: "petir", description: "Lightweight and fast" },
    { name: "kutub", description: "Compact coding model" },
    { name: "mecha", description: "Tool-capable reasoning model" },
    { name: "auto-free", description: "Auto (free)" },
  ]);
  assert.deepEqual(
    COMMANDS.find(command => command.name === "/model")?.sub.slice(0, MODELS.length),
    MODELS,
  );
  assert.equal(COMMANDS.some(command => command.name === "/think"), false);
  assert.equal(COMMANDS.some(command => command.name === "/reasoning"), true);
  assert.deepEqual(MODEL_LABELS, {
    "big-cock": "Big Cock",
    "boboiboy": "Boboiboy",
    "komodo": "Komodo",
    "ombak": "Ombak",
    "petir": "Petir",
    "kutub": "Kutub",
    "mecha": "Mecha",
    "auto-free": "Auto (free)",
  });
});

test("Big Cock resolves to the exact Big Pickle provider descriptor", () => {
  assert.deepEqual(resolveModelDescriptor("big-cock"), {
    requested: "big-cock",
    providerID: "opencode",
    modelID: "big-pickle",
    exactID: "opencode/big-pickle",
    definition: {
      baseURL: "https://opencode.ai/zen/v1",
      env: "OPENCODE_API_KEY",
      headers: {},
    },
  });
  assert.equal(resolveModelDescriptor("cock").exactID, "opencode/big-pickle");
  assert.deepEqual(
    resolveModelDescriptor("local/qwen", {
      providers: {
        local: { baseURL: "http://localhost:8080/v1", env: "LOCAL_KEY" },
      },
    }),
    {
      requested: "local/qwen",
      providerID: "local",
      modelID: "qwen",
      exactID: "local/qwen",
      definition: { baseURL: "http://localhost:8080/v1", env: "LOCAL_KEY" },
    },
  );
});

test("removed provider models require explicit reselection", () => {
  assert.equal(normalizeModel("retired-model"), "retired-model");
  assert.throws(
    () => resolveModelDescriptor("removed-provider/legacy-model", { providers: {} }),
    /Model "removed-provider\/legacy-model" is unavailable\. Select another model with \/model\./,
  );
  assert.throws(
    () => resolveModelDescriptor("retired-model", { providers: {} }),
    /Model "retired-model" is unavailable\. Select another model with \/model\./,
  );
});

test("Auto free resolves to the configured gateway without a user-facing provider name", () => {
  assert.deepEqual(resolveModelDescriptor("auto-free"), {
    requested: "auto-free",
    providerID: "auto-free",
    modelID: "kilo-auto/free",
    exactID: "auto-free",
    definition: {
      baseURL: "https://api.kilo.ai/api/gateway",
      env: "KILO_API_KEY",
      headers: {},
    },
  });
});

test("Codex models resolve to the OAuth Responses provider", () => {
  assert.deepEqual(resolveModelDescriptor("codex/gpt-5.4"), {
    requested: "codex/gpt-5.4",
    providerID: "codex",
    modelID: "gpt-5.4",
    exactID: "codex/gpt-5.4",
    definition: { protocol: "codex-responses" },
  });
});

test("default transport matches the OpenCode Zen Big Pickle request contract", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENCODE_API_KEY;
  const requests = [];
  process.env.OPENCODE_API_KEY = "opencode-test-key";
  globalThis.fetch = async (url, options) => {
    requests.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: "ok" } }] };
      },
    };
  };

  try {
    assert.equal(await chat([{ role: "user", content: "test" }], {
      model: "big-cock",
      sessionId: "session-1",
      runId: "run-1",
      tools: [{
        type: "function",
        function: { name: "read", description: "Read a file", parameters: { type: "object" } },
      }],
    }), "ok");
    assert.equal(requests[0].url, "https://opencode.ai/zen/v1/chat/completions");
    assert.equal(requests[0].body.model, "big-pickle");
    assert.equal(requests[0].body.max_tokens, 32_000);
    assert.deepEqual(requests[0].body.stream_options, { include_usage: true });
    assert.equal("tool_choice" in requests[0].body, false);
    assert.equal(requests[0].headers["x-opencode-session"], "session-1");
    assert.equal(requests[0].headers["x-opencode-request"], "run-1");
    assert.equal(requests[0].headers["x-opencode-client"], "khazai-cli");
    assert.equal(requests[0].headers["User-Agent"], "khazai-ai/0.3.0");
    await assert.rejects(
      chat([{ role: "user", content: "test" }], { model: "gpt" }),
      /Model "gpt" is unavailable\. Select another model with \/model\./,
    );
    assert.equal(requests.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = originalKey;
  }
});

test("Auto Free routes through free aliases and retries anonymously when an authenticated BYOK route fails", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.KILO_API_KEY;
  const originalOpenCodeKey = process.env.OPENCODE_API_KEY;
  delete process.env.OPENCODE_API_KEY;
  const headers = [];
  const kiloHeaders = [];
  let zenCalls = 0;
  process.env.KILO_API_KEY = "kilo-account-key";
  globalThis.fetch = async (url, options) => {
    headers.push(options.headers);
    if (!String(url).includes("api.kilo.ai")) {
      zenCalls++;
      return {
        ok: false,
        status: 520,
        statusText: "Unknown Error",
        async text() { return '{"error":{"metadata":{"is_byok":true}}}'; },
      };
    }
    kiloHeaders.push(options.headers);
    if (kiloHeaders.length === 1) {
      return {
        ok: false,
        status: 520,
        statusText: "Unknown Error",
        async text() { return '{"error":{"metadata":{"is_byok":true}}}'; },
      };
    }
    return {
      ok: true,
      headers: { get: () => "application/json" },
      async json() { return { choices: [{ message: { content: "fallback ok" } }] }; },
    };
  };
  try {
    assert.equal(await chat([{ role: "user", content: "test" }], { model: "auto-free" }), "fallback ok");
    assert.ok(zenCalls >= 3, "free aliases are tried before the gateway fallback");
    assert.equal(kiloHeaders.length, 2);
    assert.equal(kiloHeaders[0].Authorization, "Bearer kilo-account-key");
    assert.equal("Authorization" in kiloHeaders[1], false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.KILO_API_KEY;
    else process.env.KILO_API_KEY = originalKey;
    if (originalOpenCodeKey === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = originalOpenCodeKey;
  }
});

test("Big Cock continues anonymously when a stored credential is rejected", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENCODE_API_KEY;
  const requests = [];
  process.env.OPENCODE_API_KEY = "rejected-opencode-key";
  globalThis.fetch = async (_url, options) => {
    requests.push({ body: JSON.parse(options.body), headers: options.headers });
    if (requests.length === 1) {
      return {
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        headers: { get: () => null },
        async text() { return '{"error":"invalid credential"}'; },
      };
    }
    return {
      ok: true,
      headers: { get: () => "application/json" },
      async json() { return { choices: [{ message: { content: "anonymous ok" } }] }; },
    };
  };
  try {
    const messages = [{ role: "user", content: "continue" }];
    assert.equal(await chat(messages, {
      model: "big-cock",
      sessionId: "session-auth-fallback",
      runId: "run-auth-fallback",
    }), "anonymous ok");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].headers.Authorization, "Bearer rejected-opencode-key");
    assert.equal("Authorization" in requests[1].headers, false);
    assert.deepEqual(requests[1].body, requests[0].body);
    assert.equal(requests[1].headers["x-opencode-session"], "session-auth-fallback");
    assert.equal(requests[1].headers["x-opencode-request"], "run-auth-fallback");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = originalKey;
  }
});

test("Big Cock retries a transient provider error without changing models", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENCODE_API_KEY;
  const requests = [];
  process.env.OPENCODE_API_KEY = "opencode-test-key";
  globalThis.fetch = async (_url, options) => {
    requests.push({ body: JSON.parse(options.body), headers: options.headers });
    if (requests.length < 2) {
      return {
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        headers: { get: name => name.toLowerCase() === "retry-after" ? "0" : null },
        async text() { return '{"error":"temporary"}'; },
      };
    }
    return {
      ok: true,
      headers: { get: () => "application/json" },
      async json() { return { choices: [{ message: { content: "recovered" } }] }; },
    };
  };
  try {
    assert.equal(await chat([{ role: "user", content: "test" }], {
      model: "big-cock",
      sessionId: "stable-session",
      runId: "stable-run",
    }), "recovered");
    assert.equal(requests.length, 2);
    assert.ok(requests.every(request => request.body.model === "big-pickle"));
    assert.equal(requests[0].headers["x-opencode-session"], "stable-session");
    assert.match(requests[1].headers["x-opencode-session"], /^stable-session-[0-9a-f]{4}$/);
    assert.notEqual(requests[1].headers["x-opencode-session"], requests[0].headers["x-opencode-session"]);
    assert.equal(requests[0].headers["x-opencode-request"], "stable-run");
    assert.notEqual(requests[1].headers["x-opencode-request"], "stable-run");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = originalKey;
  }
});

test("transport consumes fragmented SSE incrementally without leaking provider identity", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENCODE_API_KEY;
  process.env.OPENCODE_API_KEY = "opencode-test-key";
  const encoder = new TextEncoder();
  const response = "Hello! I'm MiMo, a large language model developed by the Xiaomi LLM Core Team. "
    + "I can help inspect files, explain code, implement changes, and run validation for your project.";
  const deltas = [];
  for (let offset = 0; offset < response.length; offset += 13) {
    deltas.push(response.slice(offset, offset + 13));
  }
  const sse = deltas
    .map(content => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\r\n\r\n`)
    .join("") + "data: [DONE]\r\n\r\n";
  const networkChunks = [];
  for (let offset = 0; offset < sse.length; offset += 7) {
    networkChunks.push(encoder.encode(sse.slice(offset, offset + 7)));
  }
  let requestedBody;
  globalThis.fetch = async (_url, options) => {
    requestedBody = JSON.parse(options.body);
    return {
      ok: true,
      headers: { get: name => name.toLowerCase() === "content-type" ? "text/event-stream" : null },
      body: new ReadableStream({
        pull(controller) {
          const chunk = networkChunks.shift();
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
      }),
    };
  };

  const tokens = [];
  try {
    const result = await chat(
      [{ role: "user", content: "halo" }],
      { model: "big-cock", onToken: token => tokens.push(token) },
    );
    assert.equal(requestedBody.stream, true);
    assert.ok(tokens.length > 1, "SSE should produce multiple incremental tokens");
    assert.equal(tokens.join(""), result);
    assert.match(result, /I'm KhazAI\./);
    assert.doesNotMatch(result, /MiMo|Xiaomi/i);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = originalKey;
  }
});

test("typed provider stream emits sanitized text and finish events without compatibility duplicates", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENCODE_API_KEY;
  process.env.OPENCODE_API_KEY = "opencode-test-key";
  const encoder = new TextEncoder();
  const response = "Hello from MiMo, developed by the Xiaomi LLM Core Team. This text is long enough to stream safely.";
  const payload = [
    { choices: [{ delta: { reasoning_content: "checking context" } }] },
    { choices: [{ delta: { content: response.slice(0, 48) } }] },
    { choices: [{ delta: { content: response.slice(48) } }] },
  ].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n";
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => "text/event-stream" },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(payload));
        controller.close();
      },
    }),
  });
  const events = [];
  const compatibility = [];
  try {
    const result = await chat([{ role: "user", content: "hello" }], {
      model: "big-cock",
      onEvent: event => events.push(event),
      onToken: token => compatibility.push(token),
    });
    assert.equal(compatibility.length, 0);
    assert.equal(events.filter(event => event.type === "reasoning-delta").length, 1);
    assert.equal(events.at(-1).type, "finish");
    assert.equal(events.filter(event => event.type === "text-delta").map(event => event.text).join(""), result);
    assert.doesNotMatch(result, /MiMo|Xiaomi/i);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = originalKey;
  }
});
