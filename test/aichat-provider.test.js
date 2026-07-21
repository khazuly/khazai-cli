import assert from "node:assert/strict";
import test from "node:test";
import { AIChatProvider, compactAIChatContext } from "../lib/providers.js";

function headers(values = {}) {
  const normalized = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    get: name => normalized[String(name).toLowerCase()] ?? null,
    getSetCookie: () => normalized["set-cookie"] ? [normalized["set-cookie"]] : [],
  };
}

test("AIChat establishes a cookie session and sends Claude with CSRF", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (!options.method) {
      return {
        ok: true,
        headers: headers({ "set-cookie": "session=one; Path=/; HttpOnly" }),
        async text() { return '<meta name="csrf-token" content="csrf-one">'; },
      };
    }
    return {
      ok: true,
      headers: headers(),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'));
          controller.close();
        },
      }),
    };
  };
  try {
    const provider = new AIChatProvider();
    assert.equal(await provider.chat([{ role: "user", content: "hello" }], {
      model: "anthropic/claude-haiku-4-5",
    }), "ok");
    assert.equal(requests.length, 2);
    assert.equal(requests[1].options.headers.Cookie, "session=one");
    assert.equal(requests[1].options.headers["X-CSRF-TOKEN"], "csrf-one");
    assert.deepEqual(JSON.parse(requests[1].options.body), {
      model: "anthropic/claude-haiku-4-5",
      messages: [{ role: "user", content: "hello" }],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AIChat throws 429 error when rate limited on second attempt without refresh", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options = {}) => {
    calls++;
    if (!options.method) {
      return {
        ok: true,
        headers: headers({ "set-cookie": `session=${calls}; Path=/` }),
        async text() { return `<meta name="csrf-token" content="csrf-${calls}">`; },
      };
    }
    return {
      ok: false,
      status: 429,
      headers: headers({ "retry-after": "30" }),
    };
  };
  try {
    const provider = new AIChatProvider();
    await assert.rejects(
      provider.chat([{ role: "user", content: "hello" }], { model: "anthropic/claude-haiku-4-5" }),
      /rate limit reached.*retry after 30 seconds/i,
    );
    assert.equal(calls, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AIChat rotates its cookie after 2000 tokens while preserving message context", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  let sessions = 0;
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (!options.method) {
      sessions++;
      return {
        ok: true,
        headers: headers({ "set-cookie": `session=${sessions}; Path=/` }),
        async text() { return `<meta name="csrf-token" content="csrf-${sessions}">`; },
      };
    }
    return {
      ok: true,
      headers: headers(),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'));
          controller.close();
        },
      }),
    };
  };

  try {
    const provider = new AIChatProvider();
    assert.equal(provider.sessionVersion, 0);
    const firstMessages = [{ role: "user", content: "a".repeat(7996) }];
    await provider.chat(firstMessages, { model: "anthropic/claude-haiku-4-5" });
    assert.equal(provider.sessionTokens, 2000);
    assert.equal(provider.sessionVersion, 0);

    const rememberedMessages = [
      ...firstMessages,
      { role: "assistant", content: "ok" },
      { role: "user", content: "what did I say?" },
    ];
    await provider.chat(rememberedMessages, { model: "anthropic/claude-haiku-4-5" });

    assert.equal(sessions, 2);
    assert.equal(provider.sessionVersion, 1);
    assert.equal(requests[3].options.headers.Cookie, "session=2");
    assert.equal(requests[3].options.headers["X-CSRF-TOKEN"], "csrf-2");
    assert.deepEqual(JSON.parse(requests[3].options.body).messages, rememberedMessages);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AIChat converts native tool history into chat-compatible memory", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options = {}) => {
    if (!options.method) {
      return {
        ok: true,
        headers: headers({ "set-cookie": "session=tool-test; Path=/" }),
        async text() { return '<meta name="csrf-token" content="tool-csrf">'; },
      };
    }
    requests.push(JSON.parse(options.body));
    return {
      ok: true,
      headers: headers(),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Found it."}}]}\n\ndata: [DONE]\n\n'));
          controller.close();
        },
      }),
    };
  };

  try {
    const provider = new AIChatProvider();
    await provider.chat([
      { role: "user", content: "List files." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call-ls",
          type: "function",
          function: { name: "bash", arguments: '{"command":"ls -la"}' },
        }],
      },
      {
        role: "tool",
        tool_call_id: "call-ls",
        name: "bash",
        content: "file.txt",
      },
    ], {
      model: "anthropic/claude-haiku-4-5",
      tools: [{
        type: "function",
        function: { name: "bash", description: "Run shell", parameters: { type: "object" } },
      }],
    });

    const sent = requests[0].messages;
    assert.deepEqual(sent.map(message => message.role), ["user", "assistant", "user"]);
    assert.match(sent[0].content, /Tools are available/);
    assert.equal(sent[1].content, '{"tool":"bash","args":{"command":"ls -la"},"id":"call-ls"}');
    assert.equal(sent[2].content, "[Tool result (bash)]\nfile.txt");
    assert.equal(sent.some(message => message.role === "tool"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AIChat routes synthetic tool text through the guarded token stream", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options = {}) => {
    if (!options.method) {
      return {
        ok: true,
        headers: headers({ "set-cookie": "session=stream-test; Path=/" }),
        async text() { return '<meta name="csrf-token" content="stream-csrf">'; },
      };
    }
    const payload = '{"tool":"write","args":{"path":"snake.py","content":"import os\\\\nimport sys\\\\n"}}';
    return {
      ok: true,
      headers: headers(),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: payload } }] })}\n\ndata: [DONE]\n\n`,
          ));
          controller.close();
        },
      }),
    };
  };

  try {
    const provider = new AIChatProvider();
    const tokens = [];
    const events = [];
    const result = await provider.chat([{ role: "user", content: "Create snake.py" }], {
      model: "anthropic/claude-haiku-4-5",
      onToken: token => tokens.push(token),
      onEvent: event => events.push(event),
    });

    assert.equal(tokens.join(""), result);
    assert.match(result, /"tool":"write"/);
    assert.equal(events.some(event => event.type === "text-delta"), false);
    assert.equal(events.at(-1)?.type, "finish");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AIChat compacts oversized tool output while retaining the latest request", () => {
  const context = compactAIChatContext([
    { role: "user", content: "[Instruction] tools and system prompt" },
    { role: "assistant", content: '{"tool":"read","args":{"path":"large.py"}}' },
    { role: "user", content: `[Tool result (read)]\n${"source ".repeat(5_000)}` },
    { role: "user", content: "Continue implementing the requested change." },
  ]);

  assert.ok(context.reduce((total, message) => total + String(message.content).length, 0) <= 14_000);
  assert.match(context.at(-1).content, /Continue implementing/);
  assert.match(context.map(message => message.content).join("\n"), /characters omitted/);
});

test("AIChat keeps implementation instructions ahead of old tool output", () => {
  const instruction = "Improve the tool-call UI with a visual separator and aligned metadata.";
  const context = compactAIChatContext([
    { role: "user", content: "[Instruction] system and tool contract\n".repeat(180) },
    { role: "assistant", content: '{"tool":"read","args":{"path":"tool-presentation.js"}}' },
    { role: "user", content: `[Tool result (read)]\n${"old source ".repeat(2_000)}` },
    { role: "assistant", content: "I need clarification." },
    { role: "user", content: instruction },
    { role: "assistant", content: '{"tool":"read","args":{"path":"tool-call.js"}}' },
    { role: "user", content: `[Tool result (read)]\n${"new source ".repeat(2_000)}` },
    { role: "user", content: "Continue implementing now." },
  ]);

  const combined = context.map(message => message.content).join("\n");
  assert.ok(combined.includes(instruction));
  assert.ok(combined.includes("Continue implementing now."));
  assert.ok(context.reduce((total, message) => total + String(message.content).length, 0) <= 14_000);
});

test("AIChat keeps the agent conversation summary ahead of old tool output", () => {
  const task = "Implement the aligned visual separator for the tool-call UI.";
  const context = compactAIChatContext([
    { role: "user", content: "[Instruction] system and tool contract\n".repeat(180) },
    { role: "assistant", content: `Earlier conversation summary:\nUser: ${task}\n${"prior discussion ".repeat(800)}` },
    { role: "assistant", content: '{"tool":"read","args":{"path":"session.js"}}' },
    { role: "user", content: `[Tool result (read)]\n${"source ".repeat(2_000)}` },
    { role: "assistant", content: '{"tool":"read","args":{"path":"tool-call.js"}}' },
    { role: "user", content: `[Tool result (read)]\n${"source ".repeat(2_000)}` },
    { role: "user", content: "Continue implementation." },
  ]);

  assert.ok(context.map(message => message.content).join("\n").includes(task));
  assert.ok(context.map(message => message.content).join("\n").includes("Continue implementation."));
});

test("AIChat rotates its cookie after receiving 429 rate limit", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  let sessions = 0;
  let attempts = 0;
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (!options.method) {
      sessions++;
      return {
        ok: true,
        headers: headers({ "set-cookie": `session=${sessions}; Path=/` }),
        async text() { return `<meta name="csrf-token" content="csrf-${sessions}">`; },
      };
    }
    attempts++;
    if (attempts === 1) {
      return {
        ok: false,
        status: 429,
        headers: headers({ "retry-after": "30" }),
      };
    }
    return {
      ok: true,
      headers: headers(),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'));
          controller.close();
        },
      }),
    };
  };
  try {
    const provider = new AIChatProvider();
    assert.equal(provider.sessionVersion, 0);
    const result = await provider.chat([{ role: "user", content: "hello" }], {
      model: "anthropic/claude-haiku-4-5",
    });
    assert.equal(result, "ok");
    assert.equal(sessions, 2);
    assert.equal(provider.sessionVersion, 1);
    assert.equal(requests[3].options.headers.Cookie, "session=2");
    assert.equal(requests[3].options.headers["X-CSRF-TOKEN"], "csrf-2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AIChat preserves message context when rotating session due to 429 rate limit", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  let sessions = 0;
  let attempts = 0;
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (!options.method) {
      sessions++;
      return {
        ok: true,
        headers: headers({ "set-cookie": `session=${sessions}; Path=/` }),
        async text() { return `<meta name="csrf-token" content="csrf-${sessions}">`; },
      };
    }
    attempts++;
    if (attempts === 1) {
      return {
        ok: false,
        status: 429,
        headers: headers({ "retry-after": "30" }),
      };
    }
    return {
      ok: true,
      headers: headers(),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"context preserved"}}]}\n\ndata: [DONE]\n\n'));
          controller.close();
        },
      }),
    };
  };
  try {
    const provider = new AIChatProvider();
    const messages = [
      { role: "user", content: "First message" },
      { role: "assistant", content: "First response" },
      { role: "user", content: "Second message" },
    ];
    const result = await provider.chat(messages, { model: "anthropic/claude-haiku-4-5" });
    assert.equal(result, "context preserved");
    assert.deepEqual(JSON.parse(requests[3].options.body).messages.map(m => ({ role: m.role, length: String(m.content || "").length })),
      messages.map(m => ({ role: m.role, length: String(m.content).length })));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AIChat rotates its cookie after receiving HTML response", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  let sessions = 0;
  let attempts = 0;
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (!options.method) {
      sessions++;
      return {
        ok: true,
        headers: headers({ "set-cookie": `session=${sessions}; Path=/` }),
        async text() { return `<meta name="csrf-token" content="csrf-${sessions}">`; },
      };
    }
    attempts++;
    if (attempts === 1) {
      return {
        ok: true,
        status: 200,
        headers: headers({ "content-type": "text/html" }),
        async text() { return "<html>chat page</html>"; },
      };
    }
    return {
      ok: true,
      headers: headers({ "content-type": "text/event-stream" }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"recovered"}}]}\n\ndata: [DONE]\n\n'));
          controller.close();
        },
      }),
    };
  };
  try {
    const provider = new AIChatProvider();
    assert.equal(provider.sessionVersion, 0);
    const result = await provider.chat([{ role: "user", content: "hello" }], {
      model: "anthropic/claude-haiku-4-5",
    });
    assert.equal(result, "recovered");
    assert.equal(sessions, 2);
    assert.equal(provider.sessionVersion, 1);
    assert.equal(requests[3].options.headers.Cookie, "session=2");
    assert.equal(requests[3].options.headers["X-CSRF-TOKEN"], "csrf-2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
