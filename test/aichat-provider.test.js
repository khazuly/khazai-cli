import assert from "node:assert/strict";
import test from "node:test";
import { configuredModels } from "../config/index.js";
import { resolveProviderCapabilities } from "../config/model-settings.js";
import { resolveProviderId } from "../config/model-setting-schema.js";
import { resolveModelDescriptor } from "../lib/llm.js";
import { compactAIChatContext, prepareAIChatMessages, shouldSteerAIChatToTools } from "../lib/aichat-context.js";
import { AIChatProvider, AIChatSessionPool } from "../lib/aichat-provider.js";
import { streamDisposition } from "../app/agent/helpers/task.js";

function headers(values = {}, cookies = []) {
  return {
    get(name) { return values[String(name).toLowerCase()] || null; },
    getSetCookie() { return cookies; },
  };
}

function stream(parts) {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  });
}

function chatPage(number) {
  return {
    ok: true,
    headers: headers({}, [`session=s${number}; Path=/`]),
    text: async () => `<meta name="csrf-token" content="csrf-${number}">`,
  };
}

function usage(tokensRemaining, exhausted = false) {
  return {
    ok: true,
    headers: headers({ "content-type": "application/json" }),
    json: async () => ({ tokens_remaining: tokensRemaining, limit_exhausted: exhausted }),
  };
}

function sse(content) {
  return {
    ok: true,
    headers: headers({ "content-type": "text/event-stream" }),
    body: stream([`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`, "data: [DONE]\n\n"]),
  };
}

function httpError(status) {
  return {
    ok: false,
    status,
    statusText: "Rejected",
    headers: headers(),
    text: async () => "rejected",
  };
}

function providerWith(responses, requests = []) {
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected request: ${url}`);
    return typeof next === "function" ? next(url, options) : next;
  };
  const pool = new AIChatSessionPool({ fetchImpl, baseURL: "https://aichat.test" });
  return new AIChatProvider({ baseURL: "https://aichat.test", fetchImpl, sessionPool: pool });
}

const readTool = {
  type: "function",
  function: {
    name: "read",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
};

test("AIChat Claude is selectable with synthetic tool capability", () => {
  assert.equal(resolveProviderId("aichat/claude-haiku-4-5"), "aichat");
  assert.equal(resolveModelDescriptor("aichat/claude-haiku-4-5").modelID, "anthropic/claude-haiku-4-5");
  assert.equal(resolveProviderCapabilities("aichat/claude-haiku-4-5").supportsToolCalling, true);
  assert.ok(configuredModels().includes("aichat/claude-haiku-4-5"));
});

test("AIChat sends text-compatible messages and synthetic tool instructions without native tools", async () => {
  const requests = [];
  const provider = providerWith([
    chatPage(1),
    usage(100),
    sse('{"tool":"read","args":{"path":"lib/session.js"}}'),
  ], requests);
  const tokens = [];
  const events = [];
  const result = await provider.chat([
    { role: "system", content: "You are KhazAI." },
    { role: "assistant", content: '{"tool":"read","args":{"path":"old.js"}}' },
    { role: "tool", tool_call_id: "old", name: "read", content: "old output" },
    { role: "user", content: "Inspect the session." },
  ], {
    model: "anthropic/claude-haiku-4-5",
    sessionId: "session-a",
    tools: [readTool],
    onToken: token => tokens.push(token),
    onEvent: event => events.push(event),
  });

  const body = JSON.parse(requests.at(-1).options.body);
  assert.equal(result, '{"tool":"read","args":{"path":"lib/session.js"}}');
  assert.deepEqual(tokens, [result]);
  assert.equal(streamDisposition(tokens.join("")), "structured");
  assert.equal(events.some(event => event.type === "text-delta"), false);
  assert.equal(Object.hasOwn(body, "tools"), false);
  assert.equal(body.messages.some(message => message.role === "system"), false);
  assert.match(body.messages.at(-1).content, /TOOL CALL PROTOCOL/);
  assert.match(body.messages.at(-1).content, /concrete URL, path, identifier, or command/);
  assert.match(JSON.stringify(body.messages), /---TOOL RESULT: read---/);
});

test("AIChat unwraps a prose-wrapped synthetic tool call before it reaches the runtime", async () => {
  const provider = providerWith([
    chatPage(1),
    usage(100),
    sse('I will inspect it.\n```json\n{"tool":"read","args":{"path":"lib/session.js"}}\n```'),
  ]);
  const tokens = [];
  const result = await provider.chat([{ role: "user", content: "Inspect it." }], {
    model: "anthropic/claude-haiku-4-5", sessionId: "session-tool-wrapper", tools: [readTool],
    onToken: token => tokens.push(token),
  });

  assert.equal(result, '{"tool":"read","args":{"path":"lib/session.js"}}');
  assert.deepEqual(tokens, [result]);
});

test("AIChat restores structured assistant tool calls as text-compatible JSON", () => {
  const messages = prepareAIChatMessages([
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "call-read",
        type: "function",
        function: { name: "read", arguments: '{"path":"package.json"}' },
      }],
    },
    { role: "tool", tool_call_id: "call-read", name: "read", content: "package source" },
  ]);
  assert.match(messages[0].content, /"tool":"read"/);
  assert.match(messages[0].content, /"id":"call-read"/);
  assert.match(messages[1].content, /---TOOL RESULT: read---/);
});

test("AIChat rotates only exhausted quota sessions and replays the context", async () => {
  const requests = [];
  const provider = providerWith([
    chatPage(1),
    usage(0, true),
    chatPage(2),
    sse("remembered"),
  ], requests);
  await provider.chat([{ role: "user", content: "KHAZAI-MEMORY-7429" }], {
    model: "anthropic/claude-haiku-4-5",
    sessionId: "session-b",
  });

  assert.equal(requests.filter(request => request.url === "https://aichat.test/chat").length, 2);
  const body = JSON.parse(requests.at(-1).options.body);
  assert.match(JSON.stringify(body.messages), /KHAZAI-MEMORY-7429/);
  assert.match(requests.at(-1).options.headers.Cookie, /session=s2/);
});

test("AIChat retries once after session auth rejection but does not rotate a 429", async () => {
  const authRequests = [];
  const authProvider = providerWith([
    chatPage(1), usage(10), httpError(403), chatPage(2), sse("recovered"),
  ], authRequests);
  assert.equal(await authProvider.chat([{ role: "user", content: "retry" }], {
    model: "anthropic/claude-haiku-4-5", sessionId: "session-c",
  }), "recovered");
  assert.equal(authRequests.filter(request => request.url === "https://aichat.test/chat").length, 2);

  const rateRequests = [];
  const rateProvider = providerWith([chatPage(1), usage(10), httpError(429)], rateRequests);
  await assert.rejects(
    rateProvider.chat([{ role: "user", content: "wait" }], {
      model: "anthropic/claude-haiku-4-5", sessionId: "session-d",
    }),
    error => error.status === 429,
  );
  assert.equal(rateRequests.filter(request => request.url === "https://aichat.test/chat").length, 1);
});

test("AIChat sessions are isolated and reject HTML endpoint fallbacks", async () => {
  const requests = [];
  const provider = providerWith([
    chatPage(1), usage(10), sse("first"), chatPage(2), usage(10), sse("second"),
  ], requests);
  await provider.chat([{ role: "user", content: "first" }], {
    model: "anthropic/claude-haiku-4-5", sessionId: "session-one",
  });
  await provider.chat([{ role: "user", content: "second" }], {
    model: "anthropic/claude-haiku-4-5", sessionId: "session-two",
  });
  const posts = requests.filter(request => request.url.endsWith("/api/chat"));
  assert.match(posts[0].options.headers.Cookie, /session=s1/);
  assert.match(posts[1].options.headers.Cookie, /session=s2/);

  const htmlProvider = providerWith([
    chatPage(3), usage(10), {
      ok: true,
      headers: headers({ "content-type": "text/html" }),
      body: stream(["<html>chat</html>"]),
    }, chatPage(4), sse("recovered after refresh"),
  ]);
  assert.equal(await htmlProvider.chat([{ role: "user", content: "context" }], {
    model: "anthropic/claude-haiku-4-5", sessionId: "session-html",
  }), "recovered after refresh");
});

test("AIChat context compaction preserves user intent and recent tool output", () => {
  const messages = compactAIChatContext([
    { role: "system", content: "system" },
    { role: "user", content: "first request".repeat(200) },
    { role: "assistant", content: "earlier answer".repeat(200) },
    { role: "user", content: "latest request" },
    { role: "tool", content: "latest output".repeat(100) },
  ], 1_300);
  assert.match(JSON.stringify(messages), /latest request/);
  assert.match(JSON.stringify(messages), /latest output/);
  assert.match(JSON.stringify(messages), /Earlier conversation summary/);

  const prepared = prepareAIChatMessages([
    { role: "system", content: "Be precise." },
    { role: "user", content: "read it" },
  ], [readTool]);
  assert.equal(prepared.some(message => message.role === "system"), false);
  assert.match(prepared.at(-1).content, /TOOL CALL PROTOCOL/);
});

test("AIChat steering retries an early clarification only for a concrete URL without evidence", () => {
  assert.equal(shouldSteerAIChatToTools({
    model: "aichat/claude-haiku-4-5", input: "Inspect https://example.test", reply: "Could you clarify the goal?",
    hasTools: true, hasEvidence: false, attempt: 0,
  }), true);
  assert.equal(shouldSteerAIChatToTools({
    model: "big-cock", input: "Inspect https://example.test", reply: "Could you clarify?",
    hasTools: true, hasEvidence: false, attempt: 0,
  }), false);
  assert.equal(shouldSteerAIChatToTools({
    model: "aichat/claude-haiku-4-5", input: "Inspect https://example.test", reply: "Could you clarify?",
    hasTools: true, hasEvidence: true, attempt: 0,
  }), false);
});
