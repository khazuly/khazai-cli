import assert from "node:assert/strict";
import test from "node:test";
import { configuredModels } from "../config/index.js";
import { resolveProviderCapabilities } from "../config/model-settings.js";
import { resolveProviderId } from "../config/model-setting-schema.js";
import { resolveModelDescriptor } from "../lib/llm.js";
import {
  MistralLeChatProvider,
  ToolCallStream,
  mistralMessagesToContext,
} from "../lib/mistral-provider.js";
import { CHAT_ID, chatStream, landingResponse, liveRoutes, newChatResponse, sseResponse, toolStream, withFactory } from "./helpers/mistral-provider-fixture.js";

const twoTurns = [
  { role: "user", content: "Halo" },
  { role: "assistant", content: "Hello world" },
  { role: "user", content: "Second" },
];

test("resolveModelDescriptor maps vibe to the mistral provider", () => {
  for (const alias of ["vibe", "mistral/vibe"]) {
    const descriptor = resolveModelDescriptor(alias);
    assert.equal(descriptor.providerID, "mistral");
    assert.equal(descriptor.modelID, "vibe");
    assert.equal(descriptor.exactID, "mistral/vibe");
  }
});

test("model settings resolve the mistral provider capabilities", () => {
  assert.equal(resolveProviderId("vibe"), "mistral");
  const capabilities = resolveProviderCapabilities("vibe");
  assert.equal(capabilities.supportsToolCalling, true);
  assert.equal(capabilities.supportsStreaming, true);
});

test("vibe appears in the configured model list", () => {
  const models = configuredModels();
  assert.ok(models.includes("vibe"), "vibe should be selectable");
});

test("mistralMessagesToContext keeps the shared system prompt and formats roles", () => {
  const context = mistralMessagesToContext([
    { role: "system", content: "AGENTS.md instructions." },
    { role: "user", content: "Halo" },
  ]);
  assert.ok(context.includes("System: AGENTS.md instructions."));
  assert.ok(context.includes("User: Halo"));
});

test("mistralMessagesToContext converts tool history and injects tool schemas", () => {
  const tools = [{
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  }];
  const context = mistralMessagesToContext([
    {
      role: "assistant",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } }],
      content: "",
    },
    { role: "tool", tool_call_id: "call_1", content: "contents" },
  ], { tools });
  assert.ok(context.includes("<tool name=\"read_file\""));
  assert.ok(context.includes('Assistant: I called tool "read_file"'));
  assert.ok(context.includes("Tool result (call_1): contents"));
});

test("ToolCallStream extracts tool blocks and hides them from visible text", () => {
  const stream = new ToolCallStream();
  const chunk = stream.push('<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>tail');
  assert.equal(chunk.text, "tail");
  assert.equal(chunk.calls.length, 1);
  assert.equal(chunk.calls[0].name, "read_file");
  assert.equal(chunk.calls[0].arguments, "{\"path\":\"a\"}");
  const finish = stream.finish();
  assert.equal(finish.text, "");
});

test("provider bootstraps cookies once and streams text through the shared event interface", async () => {
  const requests = [];
  await withFactory(liveRoutes(requests), async tracker => {
    delete process.env.MISTRAL_COOKIE;
    const provider = new MistralLeChatProvider();
    const events = [];
    const result = await provider.chat(
      [{ role: "user", content: "Halo" }],
      { sessionId: "s1", onEvent: event => events.push(event) },
    );
    assert.equal(result, "Hello world");
    assert.ok(events.some(event => event.type === "first-byte"));
    assert.deepEqual(
      events.filter(event => event.type === "text-delta").map(event => event.text),
      ["Hello", " world"],
    );
    assert.equal(events.at(-1).type, "finish");
    assert.ok(requests.some(request => request.url === "newChat"));
    const send = requests.find(request => request.url === "chat");
    assert.ok(send.body.includes("User: Halo"));
    assert.equal(tracker.landings, 1);
    assert.equal(tracker.created, 1);
  });
});

test("turn 2 reuses the conversation without re-bootstrapping cookies or the session", async () => {
  const requests = [];
  await withFactory(liveRoutes(requests), async tracker => {
    delete process.env.MISTRAL_COOKIE;
    const provider = new MistralLeChatProvider();
    const first = await provider.chat(
      [{ role: "user", content: "Halo" }],
      { sessionId: "s2", onEvent: () => {} },
    );
    assert.equal(first, "Hello world");
    const second = await provider.chat(twoTurns, { sessionId: "s2", onEvent: () => {} });
    assert.equal(second, "Hello world");
    const sends = requests.filter(request => request.url === "chat");
    assert.equal(sends.length, 2);
    const newChats = requests.filter(request => request.url === "newChat");
    assert.equal(newChats.length, 1);
    const secondPayload = JSON.parse(sends[1].body);
    assert.equal(secondPayload.chatId, CHAT_ID);
    assert.ok(secondPayload.messageInput[0].text.includes("User: Second"));
    assert.ok(!secondPayload.messageInput[0].text.includes("User: Halo"));
    assert.equal(tracker.landings, 1, "cookie bootstrap must not rerun on turn 2");
    assert.equal(tracker.created, 1, "session must not be recreated on turn 2");
    assert.equal(tracker.closes, 0);
  });
});

test("a malformed stored conversation id is never reused on a later turn", async () => {
  const requests = [];
  let newChatCalls = 0;
  const routes = [
    { test: target => target.endsWith("/") && !target.includes("api"), landing: true, response: () => landingResponse() },
    { test: target => target.includes("message.newChat"), response: init => {
      newChatCalls += 1;
      requests.push({ url: "newChat", body: String(init.body || "") });
      return newChatCalls === 1 ? newChatResponse("not-a-uuid") : newChatResponse();
    } },
    { test: target => target.endsWith("/api/chat"), response: init => {
      requests.push({ url: "chat", body: String(init.body || "") });
      return sseResponse(chatStream([]));
    } },
  ];
  await withFactory(routes, async () => {
    delete process.env.MISTRAL_COOKIE;
    const provider = new MistralLeChatProvider();
    await provider.chat([{ role: "user", content: "Halo" }], { sessionId: "s-mal", onEvent: () => {} });
    await provider.chat(twoTurns, { sessionId: "s-mal", onEvent: () => {} });
    const newChats = requests.filter(request => request.url === "newChat");
    assert.equal(newChats.length, 2, "invalid conversation id forces a fresh conversation");
    const sends = requests.filter(request => request.url === "chat");
    assert.equal(sends.length, 2);
    const reused = JSON.parse(sends[1].body);
    assert.equal(reused.chatId, CHAT_ID, "stale malformed id must not be reused");
  });
});

test("session resume replays the full history in a fresh upstream chat", async () => {
  const requests = [];
  await withFactory(liveRoutes(requests), async () => {
    delete process.env.MISTRAL_COOKIE;
    const provider = new MistralLeChatProvider();
    const result = await provider.chat(
      [
        { role: "system", content: "ACTIVE TASK: finish the report" },
        { role: "user", content: "Halo" },
      ],
      { sessionId: "s-resume", onEvent: () => {} },
    );
    assert.equal(result, "Hello world");
    const newChats = requests.filter(request => request.url === "newChat");
    assert.equal(newChats.length, 1);
    const payload = JSON.parse(newChats[0].body);
    const initial = payload["0"].json.content[0].text;
    assert.ok(initial.includes("ACTIVE TASK: finish the report"));
    assert.ok(initial.includes("User: Halo"));
  });
});

test("404 on a valid conversation replays the full history without rotating the transport", async () => {
  const requests = [];
  let chatCalls = 0;
  const routes = [
    { test: target => target.endsWith("/") && !target.includes("api"), landing: true, response: () => landingResponse() },
    { test: target => target.includes("message.newChat"), response: init => {
      requests.push({ url: "newChat", body: String(init.body || "") });
      return newChatResponse();
    } },
    { test: target => target.endsWith("/api/chat"), response: init => {
      chatCalls += 1;
      requests.push({ url: "chat", body: String(init.body || "") });
      if (chatCalls === 2) return new Response("conversation not found", { status: 404 });
      return sseResponse(chatStream([]));
    } },
  ];
  await withFactory(routes, async tracker => {
    delete process.env.MISTRAL_COOKIE;
    const provider = new MistralLeChatProvider();
    const first = await provider.chat([{ role: "user", content: "Halo" }], { sessionId: "s-404r", onEvent: () => {} });
    assert.equal(first, "Hello world");
    const second = await provider.chat(twoTurns, { sessionId: "s-404r", onEvent: () => {} });
    assert.equal(second, "Hello world");
    const newChats = requests.filter(request => request.url === "newChat");
    assert.equal(newChats.length, 2, "recovery creates a fresh conversation with full history");
    const payload = JSON.parse(newChats[1].body);
    const text = payload["0"].json.content[0].text;
    assert.ok(text.includes("User: Halo"));
    assert.ok(text.includes("Assistant: Hello world"));
    assert.ok(text.includes("User: Second"));
    assert.equal(tracker.closes, 0, "404 must not rotate the transport");
  });
});

test("provider surfaces tool calls as canonical tool text", async () => {
  const requests = [];
  await withFactory(liveRoutes(requests, { stream: toolStream() }), async () => {
    delete process.env.MISTRAL_COOKIE;
    const provider = new MistralLeChatProvider();
    const events = [];
    const result = await provider.chat(
      [{ role: "user", content: "Read a.txt" }],
      { sessionId: "s3", onEvent: event => events.push(event) },
    );
    assert.deepEqual(JSON.parse(result), {
      tool: "read_file",
      args: { path: "a.txt" },
      id: "call_0",
    });
    assert.ok(events.some(event => event.type === "tool-call-delta"));
    assert.equal(events.at(-1).reason, "tool-calls");
    assert.ok(!events.some(event => event.type === "text-delta" && event.text.includes("<tool_call>")));
  });
});

test("403 rotates the transport once and retries with the canonical history intact", async () => {
  const requests = [];
  let attempts = 0;
  const routes = [
    { test: target => target.endsWith("/") && !target.includes("api"), landing: true, response: () => landingResponse() },
    { test: target => target.includes("message.newChat"), response: init => {
      attempts += 1;
      requests.push({ url: "newChat", body: String(init.body || "") });
      if (attempts === 1) return new Response("forbidden", { status: 403 });
      return newChatResponse();
    } },
    { test: target => target.endsWith("/api/chat"), response: () => sseResponse(chatStream([])) },
  ];
  await withFactory(routes, async tracker => {
    delete process.env.MISTRAL_COOKIE;
    const provider = new MistralLeChatProvider();
    const result = await provider.chat(
      [
        { role: "system", content: "ACTIVE TASK: keep this" },
        { role: "user", content: "Halo" },
      ],
      { sessionId: "s-403", onEvent: () => {} },
    );
    assert.equal(result, "Hello world");
    assert.equal(attempts, 2);
    assert.equal(tracker.closes, 1, "403 invalidates only the affected transport");
    const retried = requests.find(request => request.url === "newChat");
    assert.ok(retried.body.includes("ACTIVE TASK: keep this"));
    assert.ok(retried.body.includes("User: Halo"));
  });
});

test("429 backs off with a cooldown and rotates before retrying", async () => {
  let attempts = 0;
  const routes = [
    { test: target => target.endsWith("/") && !target.includes("api"), landing: true, response: () => landingResponse() },
    { test: target => target.includes("message.newChat"), response: () => {
      attempts += 1;
      if (attempts === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "1" } });
      return newChatResponse();
    } },
    { test: target => target.endsWith("/api/chat"), response: () => sseResponse(chatStream([])) },
  ];
  const originalRandom = Math.random;
  Math.random = () => 0.5;
  const startedAt = Date.now();
  try {
    await withFactory(routes, async () => {
      delete process.env.MISTRAL_COOKIE;
      const provider = new MistralLeChatProvider();
      const result = await provider.chat(
        [{ role: "user", content: "Halo" }],
        { sessionId: "s-429", onEvent: () => {} },
      );
      assert.equal(result, "Hello world");
      assert.equal(attempts, 2);
    });
  } finally {
    Math.random = originalRandom;
  }
  assert.ok(Date.now() - startedAt >= 900, "expected cooldown backoff before the retry");
});

test("5xx is retried with backoff without rotating the transport", async () => {
  let attempts = 0;
  const routes = [
    { test: target => target.endsWith("/") && !target.includes("api"), landing: true, response: () => landingResponse() },
    { test: target => target.includes("message.newChat"), response: () => {
      attempts += 1;
      if (attempts === 1) return new Response("boom", { status: 503 });
      return newChatResponse();
    } },
    { test: target => target.endsWith("/api/chat"), response: () => sseResponse(chatStream([])) },
  ];
  const originalRandom = Math.random;
  Math.random = () => 0.5;
  try {
    await withFactory(routes, async tracker => {
      delete process.env.MISTRAL_COOKIE;
      const provider = new MistralLeChatProvider();
      const result = await provider.chat(
        [{ role: "user", content: "Halo" }],
        { sessionId: "s-5xx", onEvent: () => {} },
      );
      assert.equal(result, "Hello world");
      assert.equal(attempts, 2);
      assert.equal(tracker.closes, 0, "5xx must not rotate the transport");
    });
  } finally {
    Math.random = originalRandom;
  }
});

test("non-retryable provider errors are not retried", async () => {
  let attempts = 0;
  const routes = [
    { test: target => target.endsWith("/") && !target.includes("api"), landing: true, response: () => landingResponse() },
    { test: target => target.includes("message.newChat"), response: () => {
      attempts += 1;
      return new Response("bad request", { status: 400 });
    } },
  ];
  await withFactory(routes, async () => {
    delete process.env.MISTRAL_COOKIE;
    const provider = new MistralLeChatProvider();
    await assert.rejects(
      provider.chat([{ role: "user", content: "Halo" }], { sessionId: "s-400", onEvent: () => {} }),
      error => error.status === 400,
    );
    assert.equal(attempts, 1);
  });
});
