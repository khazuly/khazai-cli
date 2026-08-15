import assert from "node:assert/strict";
import test from "node:test";
import { chat } from "../lib/llm.js";

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? "Unauthorized" : "OK",
    headers: { get: () => null },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

test("khazai-free retries anonymously when stored opencode credential is rejected", async t => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.OPENCODE_API_KEY;
  process.env.OPENCODE_API_KEY = "stale-key";
  globalThis.fetch = async (_url, init) => {
    calls.push(init.headers);
    if (calls.length === 1) return response(401, "unauthorized");
    return response(200, JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = originalEnv;
  });

  const result = await chat([{ role: "user", content: "hei" }], {
    model: "deepseek-v4-flash-free",
    config: { model: "deepseek-v4-flash-free", providers: {} },
    maxProviderAttempts: 1,
  });

  assert.equal(result, "ok");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].Authorization, "Bearer stale-key");
  assert.equal(calls[1].Authorization, undefined);
});

test("opencode alias still retries anonymously when stored credential is rejected", async t => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.OPENCODE_API_KEY;
  process.env.OPENCODE_API_KEY = "stale-key";
  globalThis.fetch = async (_url, init) => {
    calls.push(init.headers);
    if (calls.length === 1) return response(403, "forbidden");
    return response(200, JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = originalEnv;
  });

  const result = await chat([{ role: "user", content: "hei" }], {
    model: "big-cock",
    config: { model: "big-cock", providers: {} },
    maxProviderAttempts: 1,
  });

  assert.equal(result, "ok");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].Authorization, "Bearer stale-key");
  assert.equal(calls[1].Authorization, undefined);
});
