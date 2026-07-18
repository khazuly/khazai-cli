import assert from "node:assert/strict";
import test from "node:test";
import { normalizeUrl, npmPackageFromUrl, webTool } from "../tools/web.js";
import { bashTool } from "../tools/shell.js";
import { Agent } from "../app/agent.js";
import { Registry } from "../app/registry.js";
import { fallbackIntentContract } from "../app/intent-resolver.js";

test("fetch URL resolver adds https only when a protocol is absent", () => {
  assert.equal(normalizeUrl("aichat.org"), "https://aichat.org/");
  assert.equal(normalizeUrl("www.example.com/path?q=1"), "https://www.example.com/path?q=1");
  assert.equal(normalizeUrl("http://example.com/path"), "http://example.com/path");
  assert.equal(normalizeUrl("https://example.com/path"), "https://example.com/path");
});

test("fetch retries normalized https URL with http after a transport failure", async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async value => {
    const url = String(value);
    requests.push(url);
    if (url.startsWith("https://fallback.example")) throw new TypeError("network SSL failure");
    return new Response("<title>Fallback</title><main>ok</main>", { status: 200, headers: { "content-type": "text/html" } });
  };
  try {
    const result = await webTool.execute({ url: "fallback.example/path?q=1" });
    assert.doesNotMatch(result, /^Error:/);
    assert.equal(requests.filter(url => url === "https://fallback.example/path?q=1").length, 2);
    assert.equal(requests.at(-1), "http://fallback.example/path?q=1");
    assert.match(result, /URL: http:\/\/fallback\.example\/path\?q=1/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("invalid fetch input returns one clean error", async () => {
  const result = await webTool.execute({ url: "not a url" });
  assert.equal(result, "Error: Invalid URL");
  assert.equal((result.match(/Error:/g) || []).length, 1);
});

test("a raw-domain URL inspection completes with shell instead of a fetch tool", async () => {
  const registry = new Registry();
  registry.register({
    ...bashTool,
    async execute(args) {
      assert.match(args.command, /aichat\.org/);
      return "Exit: 0\nURL: https://aichat.org/\n<main>reachable</main>";
    },
  });
  const responses = [
    JSON.stringify({ tool: "bash", args: { command: "curl -Ls https://aichat.org | head -80" } }),
    "Inspection complete.",
  ];
  const agent = new Agent(registry, {
    workspace: "/tmp/fetch-normalize-plan",
    intentResolver: async () => ({ intent: "research", category: "RESEARCH", operation: "research", requiresPlan: true, requiredEvidence: ["research"] }),
    chat: async (_messages, options) => {
      const response = responses.shift();
      options.onToken?.(response);
      return response;
    },
  });
  const events = [];
  for await (const event of agent.loop("fetch aichat.org")) events.push(event);
  assert.equal(events.some(event => event.type === "plan-update" && event.status === "failed"), false);
  assert.equal(events.some(event => /Invalid URL/i.test(event.result || event.content || "")), false);
  assert.deepEqual(events.filter(event => event.type === "tool-call").map(event => event.tool), ["bash"]);
  assert.match(events.filter(event => event.type === "tool-result").at(0)?.result || "", /URL: https:\/\/aichat\.org\//);
});

test("bare-domain endpoint discovery uses shell-visible inspection", async () => {
  const registry = new Registry();
  const commands = [];
  registry.register({
    ...bashTool,
    async execute(args) {
      commands.push(args.command);
      return "Exit: 0\nJS chars 1200 from https://aichat.org/assets/app.js\nfetch('/api/chat', { method: 'POST' })\n[POST] /api/chat";
    },
  });
  const agent = new Agent(registry, {
    workspace: "/tmp/endpoint-discovery",
    autoApprove: true,
    intentResolver: async ({ input }) => fallbackIntentContract(input),
    chat: async (_messages, options) => {
      const response = commands.length === 0
        ? JSON.stringify({ tool: "bash", args: { command: "tmp=$(mktemp -d /tmp/khazai-endpoints-XXXXXX); curl -Ls https://aichat.org/assets/app.js > \"$tmp/app.js\"; rg \"fetch|/api|chat\" \"$tmp\"" } })
        : "Endpoint discovery complete.";
      options.onToken?.(response);
      return response;
    },
  });
  const events = [];
  for await (const event of agent.loop("discover endpoints at aichat.org")) events.push(event);
  assert.match(commands[0], /aichat\.org/);
  assert.equal(events.some(event => /Unable to continue|Invalid URL/i.test(event.content || event.result || "")), false);
  assert.deepEqual(events.filter(event => event.type === "tool-call").map(event => event.tool), ["bash"]);
});

test("npm package URLs resolve scoped and unscoped names", () => {
  assert.equal(
    npmPackageFromUrl("https://www.npmjs.com/package/@whiskeysockets/baileys"),
    "@whiskeysockets/baileys",
  );
  assert.equal(npmPackageFromUrl("https://npmjs.com/package/express"), "express");
  assert.equal(npmPackageFromUrl("https://example.com/package/express"), null);
});

test("npmjs fetch uses registry metadata and GitHub README instead of looping on 403", async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async value => {
    const url = String(value);
    requests.push(url);
    if (url.includes("registry.npmjs.org")) {
      return new Response(JSON.stringify({
        name: "@fixture/npm-readme-fallback",
        version: "7.0.0",
        description: "WhatsApp Web API library",
        license: "MIT",
        repository: { url: "git+ssh://git@github.com/Fixture/npm-readme-fallback.git" },
        homepage: "https://fixture.example/docs",
        dist: { tarball: "https://registry.npmjs.org/@fixture/npm-readme-fallback/-/pkg.tgz" },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://raw.githubusercontent.com/Fixture/npm-readme-fallback/HEAD/README.md") {
      return new Response("# Pairing example\n\nUse requestPairingCode().", {
        status: 200,
        headers: { "content-type": "text/markdown" },
      });
    }
    return new Response("blocked", { status: 403, statusText: "Forbidden" });
  };

  try {
    const result = await webTool.execute({
      url: "https://www.npmjs.com/package/@fixture/npm-readme-fallback",
    });
    assert.doesNotMatch(result, /^Error:/);
    assert.match(result, /Version: 7\.0\.0/);
    assert.match(result, /npm install @fixture\/npm-readme-fallback/);
    assert.match(result, /Use requestPairingCode\(\)/);
    assert.equal(requests.some(url => url.includes("www.npmjs.com")), false);
    assert.equal(requests.some(url => url.includes("registry.npmjs.org")), true);
    assert.equal(requests.some(url => url.includes("raw.githubusercontent.com")), true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("failed GitHub repository page falls back to its raw README", async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async value => {
    const url = String(value);
    requests.push(url);
    if (url === "https://github.com/Fixture/repository-fallback") {
      return new Response("blocked", { status: 403, statusText: "Forbidden" });
    }
    if (url === "https://raw.githubusercontent.com/Fixture/repository-fallback/HEAD/README.md") {
      return new Response("# Repository docs\n\nPairing instructions.", {
        status: 200,
        headers: { "content-type": "text/markdown" },
      });
    }
    return new Response("missing", { status: 404, statusText: "Not Found" });
  };

  try {
    const result = await webTool.execute({ url: "https://github.com/Fixture/repository-fallback" });
    assert.doesNotMatch(result, /^Error:/);
    assert.match(result, /Source: GitHub README fallback/);
    assert.match(result, /Pairing instructions/);
    assert.deepEqual(requests, [
      "https://github.com/Fixture/repository-fallback",
      "https://raw.githubusercontent.com/Fixture/repository-fallback/HEAD/README.md",
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});
