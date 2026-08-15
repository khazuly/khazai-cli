import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULTS } from "../config/defaults.js";
import { normalizeModel } from "../config/index.js";
import { chat, resolveModelDescriptor } from "../lib/llm.js";
import { setGeminiGuestRequestTransport } from "../lib/gemini-guest-provider.js";
import { COMMANDS, MODELS } from "../ui/commands.js";
import { MODEL_LABELS } from "../ui/components/banner.js";
import { handlePrimarySessionCommand } from "../ui/session-command-primary.js";

test("model selection rebuilds the agent with the active tool registry", async () => {
  const created = [];
  class TestAgent {
    constructor(registry, options) {
      created.push({ registry, options });
    }
    exportSessionState() { return { messages: [] }; }
    contextUsage() { return { currentContextTokens: 10 }; }
  }
  const savedSession = { id: "session-1", agent: "build", model: "big-cock", messages: [] };
  const context = {
    Agent: TestAgent,
    agentRef: { current: { exportSessionState: () => ({ messages: [{ role: "user", content: "task" }] }) } },
    appendArchived() {},
    autoApproveRef: { current: false },
    buildRegistry: (workspace, tools) => ({ workspace, tools }),
    configuredModels: () => ["big-cock"],
    contextUsageRef: { current: null },
    currentSessionRef: { current: savedSession },
    displayModel: value => value,
    mcpToolsRef: { current: ["mcp-tool"] },
    nextId: () => "message-1",
    saveModel() {},
    sessionStoreRef: { current: { save: session => session, updatePart() {} } },
    setContextUsage() {},
    setCurrentModel() {},
    submittingRef: { current: false },
    workspace: { path: "/workspace" },
  };

  await handlePrimarySessionCommand(context, "/model", "big-cock");

  assert.equal(created.length, 1);
  assert.deepEqual(created[0].registry, { workspace: "/workspace", tools: ["mcp-tool"] });
  assert.equal(created[0].options.model, "big-cock");
});

test("Auto Free remains the default and model menu uses short labels", () => {
  assert.equal(DEFAULTS.model, "auto-free");
  assert.equal(normalizeModel("gpt"), "big-cock");
  assert.equal(normalizeModel("local/qwen"), "local/qwen");

  const menuModels = COMMANDS.find(command => command.name === "/model")?.sub.slice(0, MODELS.length);
  assert.deepEqual(menuModels, MODELS);
  assert.equal(COMMANDS.some(command => command.name === "/think"), false);
  assert.equal(COMMANDS.some(command => command.name === "/reasoning"), true);

  assert.deepEqual(MODELS[0], { name: "Big Cock", value: "big-cock", description: "General coding" });
  const deepseek = MODELS.find(model => model.value === "deepseek/deepseek-v4-flash-free");
  assert.equal(deepseek?.name, "deepseek-v4-flash-free");
  const mimo = MODELS.find(model => model.value === "mimo/mimo-v2.5-free");
  assert.equal(mimo?.name, "mimo-v2.5-free");
  assert.equal(MODELS.some(model => model.name.includes("/") && model.value), false);
  assert.deepEqual(MODELS.at(-2), { name: "auto-free", description: "Auto (free, default)" });
  assert.deepEqual(MODELS.at(-1), { name: "Gemini 3.5 Flash", value: "gemini/3.5-flash", description: "Gemini model with tool calling" });

  assert.equal(MODEL_LABELS["big-cock"], "Big Cock");
  assert.equal(MODEL_LABELS["deepseek/deepseek-v4-flash-free"], "deepseek-v4-flash-free");
  assert.equal(MODEL_LABELS["gemini/3.5-flash"], "Gemini 3.5 Flash");
});

test("Big Cock resolves to the current OpenCode provider descriptor", () => {
  assert.deepEqual(resolveModelDescriptor("big-cock"), {
    requested: "big-cock",
    providerID: "opencode",
    modelID: "big-pickle",
    exactID: "opencode/big-pickle",
    definition: {
      baseURL: "https://opencode.ai/zen/v1",
      env: "OPENCODE_API_KEY",
      headers: {},
      family: "unknown",
      promptProfile: "big-cock",
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
      family: "unknown",
      promptProfile: "big-cock",
    },
  });
});

test("Codex models resolve to the OAuth Responses provider", () => {
  assert.deepEqual(resolveModelDescriptor("codex/gpt-5.4"), {
    requested: "codex/gpt-5.4",
    providerID: "codex",
    modelID: "gpt-5.4",
    exactID: "codex/gpt-5.4",
    definition: { protocol: "codex-responses", family: "openai", promptProfile: "codex" },
  });
});

test("default transport matches the OpenCode Zen request contract", async () => {
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

test("Auto Free uses Kilo first and falls back to free aliases after gateway failure", async () => {
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
        ok: true,
        headers: { get: () => "application/json" },
        async json() { return { choices: [{ message: { content: "zen fallback" } }] }; },
      };
    }
    kiloHeaders.push(options.headers);
    return {
      ok: false,
      status: 520,
      statusText: "Unknown Error",
      async text() { return '{"error":{"metadata":{"is_byok":true}}}'; },
    };
  };
  try {
    assert.equal(await chat([{ role: "user", content: "test" }], { model: "auto-free", maxProviderAttempts: 1 }), "zen fallback");
    assert.equal(zenCalls, 1, "the first fallback route succeeds after Kilo fails");
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
      [{ role: "user", content: "hello" }],
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

test("gemini model resolves and chats through anonymous web endpoint", async () => {
  const requests = [];
  setGeminiGuestRequestTransport(async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url) === "https://gemini.google.com/app") {
      return {
        ok: true,
        headers: { get: name => name.toLowerCase() === "set-cookie" ? "COMPASS=test; Path=/" : "text/html" },
        async text() { return '<script>window.WIZ_global_data={"cfb2h":"boq_test"}</script>'; },
      };
    }
    assert.ok(String(url).startsWith("https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?"));
    const body = String(init.body);
    assert.match(body, /f\.req=/);
    assert.match(decodeURIComponent(body), /User:\\\\nhello/);
    return {
      ok: true,
      headers: { get: () => "application/json" },
      async text() {
        const payload = [null,["c_test","r_test"],null,null,[["rc_test",["hi there"],null,null,null,null,null,null,[1],"en",null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,[],null,null,null,null,null,null,null,null,[]]],null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,"3.5 Flash"];
        return `)]}'\n\n123\n${JSON.stringify([["wrb.fr",null,JSON.stringify(payload)]])}\n`;
      },
    };
  });
  try {
    const descriptor = resolveModelDescriptor("gemini/3.5-flash");
    assert.equal(descriptor.providerID, "gemini-guest");
    assert.equal(descriptor.modelID, "3.5-flash");
    assert.equal(await chat([{ role: "user", content: "hello" }], { model: "gemini/3.5-flash", sessionId: "gemini-test" }), "hi there");
    assert.equal(requests.length, 2);
  } finally {
    setGeminiGuestRequestTransport();
  }
});

test("gemini tool instructions reject markdown-link URLs", async () => {
  const requests = [];
  setGeminiGuestRequestTransport(async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url) === "https://gemini.google.com/app") {
      return {
        ok: true,
        headers: { get: name => name.toLowerCase() === "set-cookie" ? "COMPASS=test; Path=/" : "text/html" },
        async text() { return '<script>window.WIZ_global_data={"cfb2h":"boq_test"}</script>'; },
      };
    }
    return {
      ok: true,
      headers: { get: () => "application/json" },
      async text() {
        const payload = [null,["c_test","r_test"],null,null,[["rc_test",['{"tool":"webfetch","args":{"url":"https://aichat.org"}}'],null,null,null,null,null,null,[1],"en",null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,[],null,null,null,null,null,null,null,null,[]]],null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,"3.5 Flash"];
        return `)]}'\n\n123\n${JSON.stringify([["wrb.fr",null,JSON.stringify(payload)]])}\n`;
      },
    };
  });
  try {
    const result = await chat([{ role: "user", content: "fetch [https://aichat.org](https://aichat.org)" }], {
      model: "gemini/3.5-flash",
      sessionId: "gemini-tool-url",
      tools: [{ type: "function", function: { name: "webfetch", description: "Fetch URL", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } }],
    });
    const requestText = decodeURIComponent(String(requests[1].init.body).replace(/\+/g, " "));
    assert.match(requestText, /raw URLs/);
    assert.doesNotMatch(requestText, /\[https:\/\/aichat\.org\]\(https:\/\/aichat\.org\)/);
    assert.equal(result, '{"tool":"webfetch","args":{"url":"https://aichat.org"}}');
  } finally {
    setGeminiGuestRequestTransport();
  }
});
