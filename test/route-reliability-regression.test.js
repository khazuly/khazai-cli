import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement as h } from "react";
import { render } from "ink";
import { Readable, Writable } from "node:stream";
import { Agent } from "../app/agent.js";
import { Registry } from "../app/registry.js";
import { chat, chatWithRetry } from "../lib/llm.js";
import { createStreamNormalizer } from "../lib/stream-normalizer.js";
import { normalizeMessages, normalizeTools, filterRequestOptions } from "../lib/provider-adapter.js";
import { buildRequestSnapshot, validateMessageSequence } from "../lib/request-normalizer.js";
import { fallbackCandidates } from "../lib/health-controller.js";
import { resolveRoute } from "../lib/route-registry.js";
import {
  resetProviderHealth,
  routeHealthByFingerprint,
} from "../lib/provider-reliability.js";
import { MessageList } from "../ui/components/message-list.js";

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
    statusText: "Service Unavailable",
    headers: { get: name => name.toLowerCase() === "retry-after" ? "0" : null },
    async text() { return detail; },
  };
}

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

class TerminalOutput extends Writable {
  constructor() {
    super();
    this.frames = [];
  }
  _write(chunk, _encoding, callback) {
    this.frames.push(String(chunk));
    callback();
  }
  getColorDepth() { return 24; }
  hasColors() { return true; }
}

class TerminalInput extends Readable {
  constructor() {
    super();
    this.isTTY = true;
    this.isRaw = false;
  }
  _read() {}
  setRawMode(value) { this.isRaw = value; }
  ref() {}
  unref() {}
}

function stripAnsi(text) {
  return text
    .replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "")
    .replace(/[\u200b\u2800]/g, match => match === "\u2800" ? " " : "");
}

async function renderComponent(component, columns = 60, rows = 20) {
  const stdout = new TerminalOutput();
  const stdin = new TerminalInput();
  const instance = render(component, {
    stdout,
    stdin,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await new Promise(resolve => setTimeout(resolve, 40));
  const frame = stdout.frames.map(item => stripAnsi(item).replace(/\r/g, "")).filter(item => item.trim())
    .sort((left, right) => right.length - left.length)[0] || "";
  instance.unmount();
  instance.cleanup();
  stdin.destroy();
  return frame;
}

test("canonical messages transform correctly for an OpenAI-compatible route", () => {
  const capabilities = {
    supportedRoles: ["system", "user", "assistant", "tool"],
    supportsToolCalling: true,
    supportsParallelTools: true,
    supportsStreaming: true,
    supportsTemperature: true,
    supportsTopP: true,
    supportsMaxTokens: true,
  };
  const messages = [
    { role: "system", content: "system instructions" },
    { role: "user", content: "inspect src" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call-1",
        type: "function",
        function: { name: "read", arguments: JSON.stringify({ path: "src/a.js" }) },
      }],
    },
    { role: "tool", tool_call_id: "call-1", name: "read", content: "file content" },
    { role: "assistant", content: "Done." },
  ];
  const providerMessages = normalizeMessages(messages, capabilities);
  assert.deepEqual(providerMessages.map(message => message.role), ["system", "user", "assistant", "tool", "assistant"]);
  assert.equal(providerMessages[2].tool_calls[0].function.name, "read");
  assert.equal(providerMessages[3].tool_call_id, "call-1");
  assert.equal(providerMessages[3].content, "file content");
});

test("unsupported options are omitted and tool schemas are sanitized", () => {
  const capabilities = {
    supportsToolCalling: true,
    supportsStreaming: true,
    supportsTemperature: false,
    supportsTopP: false,
    supportsMaxTokens: false,
    supportsStreamOptions: false,
    supportsParallelTools: false,
    supportsToolChoice: false,
  };
  const snapshot = buildRequestSnapshot({
    messages: [{ role: "user", content: "hi" }],
    tools: [validTool],
    options: {
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 100,
      includeUsage: true,
      parallelToolCalls: true,
      toolChoice: "auto",
    },
    capabilities,
  });
  assert.deepEqual(Object.keys(snapshot.filteredOptions), []);
  assert.deepEqual(snapshot.providerTools.map(tool => tool.function.name), ["read"]);

  const supported = buildRequestSnapshot({
    messages: [{ role: "user", content: "hi" }],
    tools: [validTool],
    options: { temperature: 0.7, maxTokens: 100 },
    capabilities: {
      supportsToolCalling: true,
      supportsStreaming: true,
      supportsTemperature: true,
      supportsMaxTokens: true,
    },
  });
  assert.equal(supported.filteredOptions.temperature, 0.7);
  assert.equal(supported.filteredOptions.maxTokens, 100);
});

test("tool-call and result pairs remain valid; orphans and broken calls are dropped", () => {
  const messages = [
    { role: "tool", tool_call_id: "ghost", name: "read", content: "orphan result" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "broken",
        type: "function",
        function: { name: "grep", arguments: "{not json" },
      }],
    },
    { role: "user", content: "plain question" },
  ];
  const output = normalizeMessages(messages, {});
  assert.deepEqual(output.map(message => message.role), ["user"]);
  const validated = validateMessageSequence(messages);
  assert.equal(validated.messages.some(message => message.role === "tool"), false);
});

test("fragmented streamed tool JSON is assembled once", () => {
  const normalizer = createStreamNormalizer({ requestId: "request-1", runId: "run-1" });
  const first = normalizer.handleChunk({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: "call-frag",
          function: { name: "read", arguments: '{"path":' },
        }],
      },
    }],
  });
  const second = normalizer.handleChunk({
    choices: [{
      delta: { tool_calls: [{ index: 0, function: { arguments: '"src/a.js"}' } }] },
    }],
  });
  const ended = normalizer.complete({ reason: "tool-calls" });

  const starts = first.filter(event => event.type === "tool_call_start");
  const deltas = [...first, ...second].filter(event => event.type === "tool_call_delta");
  const ends = ended.filter(event => event.type === "tool_call_end");
  assert.equal(starts.length, 1);
  assert.equal(deltas.length, 2);
  assert.equal(ends.length, 1);
  assert.equal(ends[0].data.arguments, '{"path":"src/a.js"}');
  assert.equal(ends[0].data.valid, true);
  assert.equal(ended.some(event => event.type === "finish"), true);
  assert.equal(ended.filter(event => event.type === "finish").length, 1);

  const calls = normalizer.toolCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "read");
  assert.deepEqual(JSON.parse(calls[0].arguments), { path: "src/a.js" });
});

test("partial failed streams are never committed", () => {
  const normalizer = createStreamNormalizer({ requestId: "request-2", runId: "run-2" });
  const deltas = normalizer.handleChunk({
    choices: [{ delta: { content: "partial answer that must never be committed" } }],
  });
  assert.equal(deltas.some(event => event.type === "text_delta"), true);

  const failure = new Error("Provider stream ended before completion.");
  failure.code = "PREMATURE_STREAM";
  const failed = normalizer.fail(failure);
  assert.deepEqual(failed.map(event => event.type), ["error"]);
  assert.equal(failed[0].data.code, "PREMATURE_STREAM");
  assert.equal(normalizer.finished, true);
  assert.equal(normalizer.failed, true);
  // No finish event is ever emitted for the failed attempt.
  const all = [...deltas, ...failed, ...normalizer.complete({ reason: "stop" })];
  assert.equal(all.filter(event => event.type === "finish").length, 0);
});

test("HTTP 503 places only the affected route into cooldown", async () => {
  resetProviderHealth();
  let calls = 0;
  const provider = {
    id: "primary",
    chatURL: () => "https://primary.test/v1/chat/completions",
    async chat() {
      calls++;
      const error = new Error("HTTP 503: Service Unavailable");
      error.status = 503;
      error.retryAfterMs = 0;
      error.providerDetail = "{\"error\":{\"message\":\"overloaded\"}}";
      throw error;
    },
  };
  const route = resolveRoute("primary/code", {
    providers: { primary: { baseURL: "https://primary.test/v1" } },
  });
  await assert.rejects(
    chatWithRetry(provider, [], { model: "code", route }, 3),
    error => {
      assert.equal(error.failureClass, "provider_infrastructure");
      assert.equal(error.attempts, 3);
      assert.equal(Number(error.status), 503);
      assert.equal(error.retryLog.length, 3);
      assert.match(error.retryLog[0].redactedResponseBody, /overloaded/);
      return true;
    },
  );
  assert.equal(calls, 3);
  const primaryHealth = routeHealthByFingerprint(route.fingerprint);
  assert.equal(primaryHealth.cooldown, true);
  assert.ok(primaryHealth.unhealthyUntil > Date.now());

  const distinct = resolveRoute("fallback/code", {
    providers: { fallback: { baseURL: "https://fallback.test/v1" } },
  });
  const distinctHealth = routeHealthByFingerprint(distinct.fingerprint);
  assert.equal(distinctHealth.cooldown, false);
  assert.equal(distinctHealth.consecutiveFailures, 0);
});

test("two aliases sharing one route are not treated as fallback alternatives", () => {
  const bigCock = resolveRoute("big-cock", {});
  const cock = resolveRoute("cock", {});
  assert.equal(bigCock.fingerprintKey, cock.fingerprintKey);
  assert.notEqual(resolveRoute("boboiboy", {}).fingerprintKey, bigCock.fingerprintKey);

  const config = {
    model: "big-cock",
    providers: { opencode: { baseURL: "https://opencode.ai/zen/v1" } },
    providerFallback: true,
    fallbackModel: "cock",
    khazaiFreeModels: { aliases: [] },
  };
  const candidates = fallbackCandidates({ alias: "big-cock", config });
  assert.deepEqual(candidates, []);

  const distinctCandidates = fallbackCandidates({
    alias: "big-cock",
    config: { ...config, fallbackModel: "boboiboy" },
  });
  assert.ok(distinctCandidates.length >= 1);
  assert.notEqual(distinctCandidates[0].fingerprintKey, bigCock.fingerprintKey);
});

test("a distinct healthy route continues the same task after 503", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const events = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body });
    return String(url).startsWith("https://primary.test")
      ? errorResponse(503, '{"error":"temporarily overloaded"}')
      : jsonResponse("fallback completed the task");
  };
  resetProviderHealth();
  try {
    const messages = [{ role: "user", content: "continue the same task" }];
    const result = await chat(messages, {
      model: "primary/code",
      maxProviderAttempts: 3,
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
    assert.equal(result, "fallback completed the task");
    assert.equal(requests.length, 4);
    assert.deepEqual(requests.map(entry => entry.body.messages), [messages, messages, messages, messages]);
    assert.ok(requests.every(entry => entry.body.tools?.[0]?.function?.name === "read"));
    assert.deepEqual(
      events.filter(event => event.type === "provider-fallback"),
      [{ type: "provider-fallback", model: "fallback/code" }],
    );

    const primaryHealth = routeHealthByFingerprint(resolveRoute("primary/code", {
      providers: { primary: { baseURL: "https://primary.test/v1" } },
    }).fingerprint);
    const fallbackHealth = routeHealthByFingerprint(resolveRoute("fallback/code", {
      providers: { fallback: { baseURL: "https://fallback.test/v1" } },
    }).fingerprint);
    assert.equal(primaryHealth.cooldown, true);
    assert.equal(fallbackHealth.cooldown, false);
  } finally {
    globalThis.fetch = originalFetch;
    resetProviderHealth();
  }
});

test("oversized contexts compact before the provider request is dispatched", async () => {
  const messages = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message-${index} ${"x".repeat(240)}`,
  }));
  const timeline = [];
  const agent = new Agent(new Registry(), {
    workspace: mkdtempSync(join(tmpdir(), "khazai-preflight-")),
    config: { modelSettings: {}, models: {}, contextLimit: 350 },
    sessionState: { messages, summary: "" },
    chat: async contextMessages => {
      timeline.push({ kind: "chat", count: contextMessages.length });
      return "Compacted answer.";
    },
  });
  const events = [];
  for await (const event of agent.loop("continue the task")) events.push(event);

  const compactionIndex = events.findIndex(event => (
    event.type === "compaction-state" && event.status === "scheduled"
  ));
  const chatIndex = timeline.findIndex(entry => entry.kind === "chat");
  assert.ok(compactionIndex >= 0, "compaction was scheduled before dispatch");
  assert.ok(chatIndex >= 0, "a provider request was eventually dispatched");
  assert.ok(compactionIndex < chatIndex + events.filter(event => event.type === "compaction-state").length, "compaction precedes the provider request");
  assert.ok(timeline[chatIndex].count < messages.length, "the request used compacted context");
  assert.equal(events.filter(event => event.type === "stream-end").length, 1);
});

test("resumed sessions are normalized before sending", async () => {
  const state = {
    messages: [
      { role: "user", content: "start" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call-resume",
          type: "function",
          function: { name: "read", arguments: JSON.stringify({ path: "a.js" }) },
        }],
      },
      { role: "tool", tool_call_id: "call-resume", name: "read", content: "result" },
      { role: "tool", tool_call_id: "ghost", name: "read", content: "orphan" },
    ],
    summary: "",
  };
  let captured;
  const agent = new Agent(new Registry(), {
    workspace: mkdtempSync(join(tmpdir(), "khazai-resume-normalize-")),
    sessionState: state,
    chat: async contextMessages => {
      captured = contextMessages;
      return "Resumed.";
    },
  });
  for await (const _event of agent.loop("continue")) {}
  assert.ok(Array.isArray(captured));
  const assistant = captured.find(message => (
    message.role === "assistant" && Array.isArray(message.tool_calls)
  ));
  assert.ok(assistant, "restored assistant tool calls survive normalization");
  const resultIndex = captured.findIndex(message => message.role === "tool");
  assert.ok(resultIndex > captured.indexOf(assistant));
  assert.equal(captured[resultIndex].tool_call_id, "call-resume");

  // The production request path normalizes the canonical context through the
  // adapter immediately before dispatch; orphan results never reach the route.
  const providerMessages = normalizeMessages(captured, {
    supportedRoles: ["system", "user", "assistant", "tool"],
    supportsToolCalling: true,
  });
  assert.equal(providerMessages.some(message => message.tool_call_id === "ghost"), false);
  const pairIndex = providerMessages.findIndex(message => message.role === "tool");
  assert.equal(providerMessages[pairIndex].tool_call_id, "call-resume");
});

test("one provider failure renders one concise UI outcome", async () => {
  const frame = await renderComponent(h(MessageList, { messages: [
    { id: "provider-failure", type: "provider-error", content: "[×] big-cock is temporarily unavailable." },
  ] }));
  assert.match(frame, /\[×\] big-cock is temporarily unavailable\./);
  assert.doesNotMatch(frame, /Finished with issues/);
  assert.doesNotMatch(frame, /^Error\b/m);
});

test("non-provider failures keep the distinct Error outcome", async () => {
  const frame = await renderComponent(h(MessageList, { messages: [
    { id: "local-error", type: "error", content: "Build failed: unresolved TypeScript error" },
  ] }));
  assert.match(frame, /Build failed: unresolved TypeScript error/);
  assert.doesNotMatch(frame, /\[×\]/);
});
