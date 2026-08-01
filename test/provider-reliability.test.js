import assert from "node:assert/strict";
import test from "node:test";
import { chat, chatWithRetry } from "../lib/llm.js";
import { OpenAICompatibleProvider } from "../lib/providers.js";
import { clearOutboundTransports, rotateOutboundTransport } from "../lib/ip-rotator.js";
import { normalizeTools } from "../lib/provider-adapter.js";
import { normalizeLlmProxyMessage, normalizeLlmProxyText } from "../lib/prompt-tool-protocol.js";
import {
  classifyProviderFailure,
  providerDiagnostic,
  resetProviderHealth,
} from "../lib/provider-reliability.js";

function jsonResponse(content = "ok") {
  return {
    ok: true,
    headers: { get: () => "application/json" },
    async json() {
      return { choices: [{ message: { content } }] };
    },
  };
}

function errorResponse(status, detail) {
  return {
    ok: false,
    status,
    statusText: "Internal Server Error",
    headers: { get: name => name.toLowerCase() === "retry-after" ? "0" : null },
    async text() { return detail; },
  };
}

test("provider tool schemas reuse the transformed result for one registry revision", () => {
  const tools = [{
    type: "function",
    function: {
      name: "read",
      description: "Read a file.",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  }];
  const first = normalizeTools(tools, { supportsToolCalling: true });
  const second = normalizeTools(tools, { supportsToolCalling: true });
  assert.equal(first, second);
});

const validTool = {
  type: "function",
  function: {
    name: "read",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
};

test("deterministic HTTP 500 payload errors are classified without repeated retries", async () => {
  let calls = 0;
  const provider = {
    id: "local",
    chatURL: () => "https://local.test/v1/chat/completions",
    async chat() {
      calls++;
      const error = new Error("HTTP 500: Internal Server Error");
      error.status = 500;
      error.providerDetail = '{"error":{"message":"Unknown parameter: temperature"}}';
      throw error;
    },
  };
  resetProviderHealth();
  await assert.rejects(
    chatWithRetry(provider, [], { model: "test", retryRandom: () => 0.5 }, 3),
    error => error.failureClass === "unsupported_parameter" && error.attempts === 1,
  );
  assert.equal(calls, 1);
});

test("provider capabilities remove unsupported request fields", async () => {
  const originalFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return jsonResponse();
  };
  try {
    const provider = new OpenAICompatibleProvider({
      id: "local",
      baseURL: "https://local.test/v1",
    });
    await provider.chat([{ role: "user", content: "test" }], {
      model: "test",
      tools: [validTool],
      includeUsage: true,
      maxTokens: 100,
      temperature: 0.7,
      topP: 0.9,
      toolChoice: "auto",
      parallelToolCalls: true,
      capabilities: {
        supportsStreaming: true,
        supportsToolCalling: true,
        supportsTemperature: false,
        supportsTopP: false,
        supportsMaxTokens: false,
        supportsStreamOptions: false,
        supportsToolChoice: false,
        supportsParallelTools: false,
      },
    });
    assert.deepEqual(Object.keys(body).sort(), ["messages", "model", "stream", "tools"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("invalid tool schemas fail locally before provider execution", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return jsonResponse();
  };
  try {
    const provider = new OpenAICompatibleProvider({
      id: "local",
      baseURL: "https://local.test/v1",
    });
    await assert.rejects(
      provider.chat([], {
        model: "test",
        tools: [{
          type: "function",
          function: { name: "read", parameters: { type: "array" } },
        }],
      }),
      error => error.failureClass === "invalid_tool_schema",
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a healthy plain route is quarantined when tool requests consistently fail", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    return body.tools?.length
      ? errorResponse(500, '{"error":"Internal server error"}')
      : jsonResponse("plain ok");
  };
  resetProviderHealth();
  try {
    const provider = new OpenAICompatibleProvider({
      id: "local",
      baseURL: "https://local.test/v1",
    });
    assert.equal(await chatWithRetry(provider, [], { model: "test" }, 3), "plain ok");
    await assert.rejects(
      chatWithRetry(provider, [], { model: "test", tools: [validTool] }, 3),
      error => error.failureClass === "unhealthy_tool_route" && error.attempts === 1,
    );
    await assert.rejects(
      chatWithRetry(provider, [], { model: "test", tools: [validTool] }, 3),
      error => error.failureClass === "unhealthy_tool_route" && error.attempts === 0,
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    resetProviderHealth();
  }
});

test("three infrastructure failures quarantine the resolved route", async () => {
  let calls = 0;
  const provider = {
    id: "local",
    chatURL: () => "https://unhealthy.test/v1/chat/completions",
    async chat() {
      calls++;
      const error = new Error("HTTP 500: Internal Server Error");
      error.status = 500;
      error.retryAfterMs = 0;
      throw error;
    },
  };
  resetProviderHealth();
  await assert.rejects(
    chatWithRetry(provider, [], { model: "test" }, 3),
    error => error.failureClass === "provider_infrastructure" && error.attempts === 3,
  );
  await assert.rejects(
    chatWithRetry(provider, [], { model: "test" }, 3),
    error => error.failureClass === "unhealthy_model_route" && error.attempts === 0,
  );
  assert.equal(calls, 3);
  resetProviderHealth();
});

test("explicit fallback preserves messages and reports the resolved model", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const events = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, body });
    return url.startsWith("https://primary.test")
      ? errorResponse(500, '{"error":"temporary infrastructure failure"}')
      : jsonResponse("fallback ok");
  };
  resetProviderHealth();
  try {
    const messages = [{ role: "user", content: "keep this task" }];
    const result = await chat(messages, {
      model: "primary/code",
      maxProviderAttempts: 2,
      tools: [validTool],
      onEvent: event => events.push(event),
      config: {
        model: "primary/code",
        providers: {
          primary: { baseURL: "https://primary.test/v1", capabilities: { tools: true } },
          fallback: { baseURL: "https://fallback.test/v1", capabilities: { tools: true } },
        },
        providerFallback: true,
        fallbackModel: "fallback/code",
      },
    });
    assert.equal(result, "fallback ok");
    assert.equal(requests.length, 3);
    assert.deepEqual(requests.map(entry => entry.body.messages), [messages, messages, messages]);
    assert.ok(requests.every(entry => entry.body.tools?.[0]?.function?.name === "read"));
    assert.deepEqual(
      events.filter(event => event.type === "provider-fallback"),
      [{ type: "provider-fallback", model: "fallback/code" }],
    );
  } finally {
    globalThis.fetch = originalFetch;
    resetProviderHealth();
  }
});

test("rotating transport retries only the request with unchanged canonical messages", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  clearOutboundTransports();
  resetProviderHealth();
  globalThis.fetch = async (_url, options) => {
    requests.push({ headers: options.headers, body: JSON.parse(options.body) });
    return requests.length === 1
      ? errorResponse(500, '{"error":"temporary"}')
      : jsonResponse("continued");
  };
  try {
    const messages = [
      { role: "system", content: "Workspace instructions" },
      { role: "user", content: "Remember KHAZAI-ROTATE-731" },
      { role: "assistant", content: "Inspected package.json" },
    ];
    const provider = new OpenAICompatibleProvider({
      id: "khazai-rotate",
      baseURL: "https://rotate.test/chat.php",
      rotateClientIp: true,
      transportKey: "khazai-rotate:test",
      publicName: "KhazAI",
      hideUpstreamDiagnostics: true,
    });
    const result = await chatWithRetry(provider, messages, {
      alias: "chatgpt",
      model: "chatgpt",
      requestId: "request-1",
      runId: "run-1",
      turnId: "turn-1",
      taskEpoch: 1,
      retryRandom: () => 0,
    }, 2);
    assert.equal(result, "continued");
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].body.messages, messages);
    assert.deepEqual(requests[1].body.messages, messages);
    assert.notEqual(requests[0].headers["X-Forwarded-For"], requests[1].headers["X-Forwarded-For"]);
  } finally {
    globalThis.fetch = originalFetch;
    clearOutboundTransports();
    resetProviderHealth();
  }
});

test("callbacks from an old transport revision are ignored", async () => {
  const originalFetch = globalThis.fetch;
  let release;
  const response = new Promise(resolve => { release = resolve; });
  clearOutboundTransports();
  globalThis.fetch = async () => response;
  const events = [];
  try {
    const provider = new OpenAICompatibleProvider({
      id: "khazai-rotate",
      baseURL: "https://rotate.test/chat.php",
      rotateClientIp: true,
      transportKey: "khazai-rotate:stale",
    });
    const options = provider.retryOptions({
      model: "chatgpt",
      onEvent: event => events.push(event),
    }, 0);
    const pending = provider.chat([{ role: "user", content: "keep context" }], options);
    rotateOutboundTransport("khazai-rotate:stale", "rotation-new");
    release(jsonResponse("stale response"));
    assert.equal(await pending, "stale response");
    assert.deepEqual(events, []);
  } finally {
    globalThis.fetch = originalFetch;
    clearOutboundTransports();
  }
});

test("mid-request rotation retries the same canonical request on the new transport", async () => {
  const originalFetch = globalThis.fetch;
  let release;
  const firstResponse = new Promise(resolve => { release = resolve; });
  const requests = [];
  clearOutboundTransports();
  resetProviderHealth();
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return requests.length === 1 ? firstResponse : jsonResponse("new transport response");
  };
  try {
    const messages = [{ role: "user", content: "Preserve KHAZAI-ROTATE-731" }];
    const provider = new OpenAICompatibleProvider({
      id: "khazai-rotate",
      baseURL: "https://rotate.test/chat.php",
      rotateClientIp: true,
      transportKey: "khazai-rotate:mid-request",
    });
    const pending = chatWithRetry(provider, messages, {
      alias: "chatgpt",
      model: "chatgpt",
      requestId: "request-mid",
    }, 2);
    await new Promise(resolve => setImmediate(resolve));
    rotateOutboundTransport("khazai-rotate:mid-request", "rotation-mid");
    release(jsonResponse("old transport response"));
    assert.equal(await pending, "new transport response");
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].messages, messages);
    assert.deepEqual(requests[1].messages, messages);
  } finally {
    globalThis.fetch = originalFetch;
    clearOutboundTransports();
    resetProviderHealth();
  }
});

test("diagnostics redact provider details and classify premature streams", () => {
  const error = new Error("Provider stream ended before completion.");
  error.code = "PREMATURE_STREAM";
  error.providerDetail = "Authorization: Bearer sk-example-secret";
  const diagnostic = providerDiagnostic(
    { id: "local", chatURL: () => "https://local.test/v1/chat/completions" },
    { model: "test", requestId: "request-1", tools: [] },
    error,
    1,
    classifyProviderFailure(error),
  );
  assert.equal(diagnostic.failureClass, "premature_stream");
  assert.doesNotMatch(diagnostic.redactedResponseBody, /sk-example-secret/);
  assert.match(diagnostic.redactedResponseBody, /\[REDACTED\]/);
});

test("rotating transport diagnostics expose only KhazAI branding", () => {
  const error = new Error("HTTP 500");
  error.endpoint = "https://upstream.invalid/chat";
  const diagnostic = providerDiagnostic(
    {
      id: "khazai-rotate",
      publicName: "KhazAI",
      hideUpstreamDiagnostics: true,
      chatURL: () => error.endpoint,
    },
    {
      alias: "chatgpt",
      model: "upstream-model",
      upstreamModel: "upstream-model",
      requestId: "request-2",
      transportRevision: 3,
      rotationId: "rotation-3",
    },
    error,
    1,
    "provider_infrastructure",
  );
  assert.equal(diagnostic.provider, "KhazAI");
  assert.equal(diagnostic.model, "chatgpt");
  assert.equal(diagnostic.upstreamModel, "");
  assert.equal(diagnostic.endpoint, "");
  assert.equal(diagnostic.transportRevision, 3);
  assert.equal(diagnostic.rotationId, "rotation-3");
});

test("llmproxy response normalization supports native, legacy, and strict XML calls", () => {
  const native = normalizeLlmProxyMessage({
    tool_calls: [{ id: "native-1", function: { name: "terminal", arguments: '{"command":"pwd"}' } }],
  }, "request-native");
  assert.equal(native.tool_calls[0].function.name, "bash");
  const legacy = normalizeLlmProxyMessage({
    function_call: { name: "grep", arguments: '{"pattern":"needle"}' },
  }, "request-legacy");
  assert.equal(legacy.tool_calls[0].function.name, "grep");
  const xml = normalizeLlmProxyText(
    '<functions><function><name>bash</name><args>{"command":"ls -la","workdir":"/root/chatai"}</args></function></functions>',
    "request-xml",
  );
  assert.equal(xml.kind, "tool");
  assert.deepEqual(xml.tool.args, { command: "ls -la", workdir: "/root/chatai" });
  assert.equal(normalizeLlmProxyText("Prose with <functions>documentation</functions> inside.").kind, "prose");
  assert.equal(
    normalizeLlmProxyText("<functions><function><name>bash</name><args>{bad}</args></function></functions>").text,
    "[×] Invalid llmproxy tool call.",
  );
});

test("llmproxy streaming buffers XML and emits one canonical tool call", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const fragments = [
    "<functions><function><name>bash</name><args>",
    '{"command":"ls -la"}',
    "</args></function></functions>",
  ];
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: name => name.toLowerCase() === "content-type" ? "text/event-stream" : null },
    body: new ReadableStream({
      start(controller) {
        for (const content of fragments) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`));
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
  });
  const events = [];
  try {
    const provider = new OpenAICompatibleProvider({
      id: "khazai-rotate",
      baseURL: "https://rotate.test/chat.php",
      compatibility: { toolProtocol: "prompt-json" },
    });
    const result = await provider.chat([{ role: "user", content: "list files" }], {
      model: "chatgpt",
      tools: [validTool],
      requestId: "request-stream",
      capabilities: { supportsStreaming: true, supportsToolCalling: true },
      onEvent: event => events.push(event),
    });
    assert.equal(JSON.parse(result).tool, "bash");
    assert.equal(events.filter(event => event.type === "tool-call-delta").length, 1);
    assert.equal(events.some(event => event.type === "text-delta" && /<functions>/.test(event.text)), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
