import assert from "node:assert/strict";
import test from "node:test";
import { npmPackageFromUrl, webTool } from "../tools/web.js";

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
