import assert from "node:assert/strict";
import test from "node:test";
import { chat, chatWithRetry } from "../lib/llm.js";
import { OpenAICompatibleProvider } from "../lib/providers.js";
import { normalizeTools } from "../lib/provider-adapter.js";
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
