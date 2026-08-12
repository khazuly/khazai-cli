import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h } from "react";
import { render } from "ink";
import { promptFamily } from "../app/prompts.js";
import { configuredModels } from "../config/index.js";
import { resolveProviderCapabilities } from "../config/model-settings.js";
import { resolveModelDescriptor } from "../lib/model-resolver.js";
import { resolveProvider } from "../lib/llm.js";
import {
  QWEN_CLOUD_BASE_URL,
  QWEN_CLOUD_ID,
  qwenCloudCatalog,
  validateQwenCloudConnection,
} from "../lib/qwen-cloud.js";
import { connectProvider } from "../ui/provider-command.js";
import { PromptInput } from "../ui/components/prompt-input.js";
import { TerminalInput, TerminalOutput, stripAnsi } from "./helpers/ink-render.js";

function response(status, body = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function qwenConfig(models = qwenCloudCatalog()) {
  return {
    model: "big-cock",
    providers: {
      [QWEN_CLOUD_ID]: {
        type: "openai-compatible",
        baseURL: QWEN_CLOUD_BASE_URL,
        env: "DASHSCOPE_API_KEY",
        models,
      },
    },
  };
}

test("Qwen Cloud validates with authenticated dynamic model discovery", async () => {
  const requests = [];
  const models = await validateQwenCloudConnection({
    apiKey: "sk-test-key",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/models")) return response(200, { data: [{ id: "qwen3.7-plus" }, { id: "glm-5" }] });
      return response(200, { choices: [{ message: { content: "pong" } }] });
    },
  });
  assert.deepEqual(models.map(model => model.publicName), ["qwen/qwen3.7-plus", "glm/glm-5"]);
  assert.equal(requests[0].options.headers.Authorization, "Bearer sk-test-key");
  assert.equal(JSON.parse(requests[1].options.body).model, "qwen3.7-plus");
});

test("Qwen Cloud maps connection failures without provider response details", async () => {
  await assert.rejects(
    validateQwenCloudConnection({ apiKey: "sk-test-key", fetchImpl: async () => response(401) }),
    /authentication was rejected/,
  );
  await assert.rejects(
    validateQwenCloudConnection({ apiKey: "sk-test-key", fetchImpl: async () => response(500) }),
    /temporarily unavailable/,
  );
});

test("Qwen Cloud models resolve to the shared OpenAI-compatible provider", () => {
  const config = qwenConfig();
  const descriptor = resolveModelDescriptor("deepseek/deepseek-v4-pro", config);
  assert.equal(descriptor.providerID, QWEN_CLOUD_ID);
  assert.equal(descriptor.modelID, "deepseek-v4-pro");
  assert.equal(promptFamily(descriptor), "deepseek");
  assert.equal(resolveProviderCapabilities("deepseek/deepseek-v4-pro", descriptor.definition).supportsToolCalling, true);
  const previous = process.env.DASHSCOPE_API_KEY;
  process.env.DASHSCOPE_API_KEY = "sk-test-key";
  try {
    const first = resolveProvider("qwen/qwen3.7-plus", config);
    const second = resolveProvider("qwen/qwen3.7-plus", config);
    assert.equal(first.provider, second.provider);
    assert.equal(first.provider.id, QWEN_CLOUD_ID);
    assert.equal(first.model, "qwen3.7-plus");
  } finally {
    if (previous === undefined) delete process.env.DASHSCOPE_API_KEY;
    else process.env.DASHSCOPE_API_KEY = previous;
  }
});

test("Qwen Cloud streams native tool calls through the shared provider adapter", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: name => name === "content-type" ? "text/event-stream" : null },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: [{
            index: 0, id: "call_read", type: "function",
            function: { name: "read", arguments: '{"path":"README.md"}' },
          }] } }],
        })}\n\ndata: [DONE]\n\n`));
        controller.close();
      },
    }),
  });
  const previous = process.env.DASHSCOPE_API_KEY;
  process.env.DASHSCOPE_API_KEY = "sk-test-key";
  try {
    const resolved = resolveProvider("qwen/qwen3.7-plus", qwenConfig());
    const events = [];
    const output = await resolved.provider.chat([{ role: "user", content: "Read README.md" }], {
      model: resolved.model,
      tools: [{
        type: "function",
        function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } },
      }],
      capabilities: resolveProviderCapabilities("qwen/qwen3.7-plus", resolved.definition),
      onEvent: event => events.push(event),
    });
    assert.match(output, /"tool":"read"/);
    assert.equal(events.at(-1).reason, "tool-calls");
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.DASHSCOPE_API_KEY;
    else process.env.DASHSCOPE_API_KEY = previous;
  }
});

test("Qwen Cloud is selectable only after it is configured", () => {
  const original = configuredModels;
  assert.ok(typeof original === "function");
  const config = qwenConfig();
  assert.equal(resolveModelDescriptor("qwen/qwen3.7-plus", config).exactID, "qwen/qwen3.7-plus");
  assert.throws(() => resolveModelDescriptor("qwen/qwen3.7-plus", { providers: {} }), /unavailable/);
});

test("Qwen Cloud connect uses a masked, non-archived API key prompt", async () => {
  const questions = [];
  const messages = [];
  const stored = [];
  const saved = [];
  await connectProvider("", {
    appendArchived: message => messages.push(message),
    chooseModel: async () => {},
    listModels: async () => [],
    loadConfig: () => ({ providers: {} }),
    loginCodex: async () => {},
    requestValue: async (question, _options, settings) => {
      questions.push({ question, settings });
      return question === "Select a provider" ? QWEN_CLOUD_ID : "sk-test-key";
    },
    saveProvider: (id, definition) => saved.push({ id, definition }),
    saveProviderCredential: (id, value) => stored.push({ id, value }),
    validateQwenCloudConnection: async () => qwenCloudCatalog().slice(0, 1),
  });
  assert.deepEqual(questions.map(entry => entry.question), ["Select a provider", "Connect Qwen Cloud\n\nAPI Key"]);
  assert.equal(questions[1].settings.secret, true);
  assert.equal(stored[0].id, QWEN_CLOUD_ID);
  assert.equal(stored[0].value, "sk-test-key");
  assert.equal(saved[0].definition.baseURL, QWEN_CLOUD_BASE_URL);
  assert.equal(messages.at(-1).content, "Qwen Cloud connected.");
});

test("secret input masks API keys and Escape cancels", async () => {
  const stdout = new TerminalOutput(40, 12);
  const stdin = new TerminalInput();
  let cancelled = 0;
  const view = render(h(PromptInput, {
    onSubmit() {}, onCommand() {}, commands: [], secret: true, question: "API Key",
    onCancelInput: () => { cancelled++; },
  }), { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false });
  await new Promise(resolve => setTimeout(resolve, 30));
  for (const character of "sk-test-key") {
    stdin.push(character);
    await new Promise(resolve => setTimeout(resolve, 12));
  }
  await new Promise(resolve => setTimeout(resolve, 50));
  const output = stripAnsi(stdout.frames.join(""));
  assert.doesNotMatch(output, /sk-test-key/);
  assert.match(output, /•••••••••••/);
  stdin.push("\r");
  await new Promise(resolve => setTimeout(resolve, 30));
  view.rerender(h(PromptInput, {
    onSubmit() {}, onCommand() {}, commands: [], question: "API Key",
    onCancelInput: () => { cancelled++; },
  }));
  await new Promise(resolve => setTimeout(resolve, 30));
  stdin.push("\u001b[A");
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.doesNotMatch(stripAnsi(stdout.frames.join("")), /sk-test-key/);
  stdin.push("\u001b");
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(cancelled, 1);
  view.unmount();
  view.cleanup();
  stdin.destroy();
});
