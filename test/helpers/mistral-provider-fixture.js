import { setMistralSessionFactory } from "../../lib/mistral-provider.js";
import { createSession } from "wreq-js";

export const CHAT_ID = "260d38f4-e258-4a49-ac8d-6aedb27585b5";
export const MSG_ID = "c5716078-5a8d-4769-b2eb-e224744a3194";

export function sseResponse(lines) {
  const body = new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(new TextEncoder().encode(`${line}\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

export function newChatResponse(chatId = CHAT_ID, msgId = MSG_ID) {
  return new Response(JSON.stringify([{ result: { data: { json: { chatId, messages: { id: msgId } } } } }]), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export function landingResponse() {
  return new Response("<!doctype html><html><body>chat</body></html>", {
    status: 200,
    headers: { "set-cookie": "anonymousUser=anon-123; Path=/; HttpOnly" },
  });
}

export function chatStream(lines) {
  return [
    `event: ${JSON.stringify({ json: { type: "message", patches: [{ op: "replace", path: "/contentChunks", value: [{ text: "Hel" }, { text: "lo" }] }] } })}`,
    `event: ${JSON.stringify({ json: { type: "message", patches: [{ op: "add", path: "/contentChunks/1/text", value: " world" }] } })}`,
    ...lines,
  ];
}

export function toolStream() {
  return [
    `event: ${JSON.stringify({ json: { type: "message", patches: [{ op: "replace", path: "/contentChunks", value: [{ text: "<tool_call>" }] }] } })}`,
    `event: ${JSON.stringify({ json: { type: "message", patches: [{ op: "add", path: "/contentChunks/0/text", value: "{\"name\":\"read_file\",\"arguments\":{\"path\":\"a.txt\"}}" }] } })}`,
    `event: ${JSON.stringify({ json: { type: "message", patches: [{ op: "add", path: "/contentChunks/0/text", value: "</tool_call>" }] } })}`,
  ];
}

function fakeSession(routes, tracker) {
  const jar = {};
  let closed = false;
  return {
    id: `sess-${(tracker.created += 1)}`,
    get closed() { return closed; },
    setCookie(name, value) { jar[name] = value; },
    getCookies() { return { ...jar }; },
    getAllCookies() { return Object.entries(jar).map(([name, value]) => ({ name, value, domain: "chat.mistral.ai", path: "/" })); },
    async fetch(url, init = {}) {
      const target = String(url);
      const entry = routes.find(route => route.test(target));
      if (!entry) return new Response("not found", { status: 404 });
      if (entry.landing) {
        tracker.landings += 1;
        jar.anonymousUser = "anon-123";
      }
      return entry.response(init);
    },
    async close() {
      tracker.closes += 1;
      closed = true;
    },
  };
}

export function withFactory(routes, fn) {
  const tracker = { created: 0, landings: 0, closes: 0 };
  setMistralSessionFactory(async () => fakeSession(routes, tracker));
  return Promise.resolve(fn(tracker)).finally(() => setMistralSessionFactory(createSession));
}

export function liveRoutes(requests, options = {}) {
  return [
    { test: target => target.endsWith("/") && !target.includes("api"), landing: true, response: () => landingResponse() },
    { test: target => target.includes("message.newChat"), response: init => { requests.push({ url: "newChat", body: String(init.body || "") }); return options.newChat ? options.newChat() : newChatResponse(); } },
    { test: target => target.endsWith("/api/chat"), response: init => { requests.push({ url: "chat", body: String(init.body || "") }); return options.stream ? sseResponse(options.stream) : sseResponse(chatStream([])); } },
  ];
}

function hangingChatRoute(requests) {
  return init => {
    requests.push("chat");
    if (init.signal?.aborted) throw init.signal.reason || new Error("Aborted");
    return new Promise((resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason || new Error("Aborted")), { once: true });
    });
  };
}

export function timeoutRoutes(requests) {
  return [
    { test: target => target.endsWith("/") && !target.includes("api"), landing: true, response: () => landingResponse() },
    { test: target => target.includes("message.newChat"), response: () => newChatResponse() },
    { test: target => target.endsWith("/api/chat"), response: hangingChatRoute(requests) },
  ];
}
