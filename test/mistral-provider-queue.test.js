import assert from "node:assert/strict";
import test from "node:test";
import { MistralLeChatProvider } from "../lib/mistral-provider.js";
import { liveRoutes, timeoutRoutes, withFactory } from "./helpers/mistral-provider-fixture.js";

test("a queued request gets a fresh timeout window once it starts executing", async () => {
  const requests = [];
  const routes = timeoutRoutes(requests);
  routes[2].response = init => {
    if (init.signal?.aborted) throw init.signal.reason || new Error("Aborted");
    const firstRequest = requests.length === 0;
    requests.push("chat");
    if (firstRequest) {
      return new Promise((resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason || new Error("Aborted")), { once: true });
      });
    }
    const event = `event: ${JSON.stringify({ json: { type: "message", patches: [{ op: "replace", path: "/contentChunks", value: [{ text: "Hello world" }] }] } })}`;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${event}\n`));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  await withFactory(routes, async tracker => {
    delete process.env.MISTRAL_COOKIE;
    const provider = new MistralLeChatProvider();
    const first = provider.chat([{ role: "user", content: "one" }], { sessionId: "s-window", timeoutMs: 1000, onEvent: () => {} });
    const second = provider.chat([{ role: "user", content: "two" }], { sessionId: "s-window", timeoutMs: 400, onEvent: () => {} });
    await assert.rejects(first, error => error.message === "Request timed out");
    assert.equal(await second, "Hello world");
    assert.equal(requests.length, 2);
    assert.equal(tracker.closes, 0);
  });
});

test("a cancelled queued request never executes and leaves the transport intact", async () => {
  const requests = [];
  await withFactory(timeoutRoutes(requests), async tracker => {
    delete process.env.MISTRAL_COOKIE;
    const provider = new MistralLeChatProvider();
    const first = provider.chat([{ role: "user", content: "one" }], { sessionId: "s-cancel", timeoutMs: 800, onEvent: () => {} });
    const control = new AbortController();
    const second = provider.chat([{ role: "user", content: "two" }], { sessionId: "s-cancel", timeoutMs: 5000, onEvent: () => {}, signal: control.signal });
    control.abort(new Error("User cancelled"));
    await assert.rejects(first, error => error.message === "Request timed out");
    await assert.rejects(second, error => error.message === "User cancelled");
    assert.equal(requests.length, 1);
    assert.equal(tracker.closes, 0);
  });
});

test("a timed-out request stops without retrying or rotating the transport", async () => {
  const requests = [];
  await withFactory(timeoutRoutes(requests), async tracker => {
    delete process.env.MISTRAL_COOKIE;
    const provider = new MistralLeChatProvider();
    await assert.rejects(
      provider.chat([{ role: "user", content: "Halo" }], { sessionId: "s-timeout", timeoutMs: 200, onEvent: () => {} }),
      error => error.message === "Request timed out",
    );
    assert.equal(requests.length, 1);
    assert.equal(tracker.closes, 0);
  });
});

test("MISTRAL_COOKIE seeds the session jar without a landing fetch", async () => {
  const requests = [];
  await withFactory(liveRoutes(requests), async tracker => {
    process.env.MISTRAL_COOKIE = "csrftoken=abc; anonymousUser=seeded-anon";
    try {
      const provider = new MistralLeChatProvider();
      assert.equal(await provider.chat([{ role: "user", content: "Halo" }], { sessionId: "s-seed", onEvent: () => {} }), "Hello world");
      assert.equal(tracker.landings, 0);
      assert.equal(tracker.created, 1);
    } finally {
      delete process.env.MISTRAL_COOKIE;
    }
  });
});
