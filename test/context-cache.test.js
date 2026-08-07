import assert from "node:assert/strict";
import test from "node:test";
import { ContextCache } from "../app/context-cache.js";

test("token entries are bounded and oldest entries are evicted", () => {
  const cache = new ContextCache();
  for (let index = 0; index < 3000; index++) {
    cache.messageMeta({ id: `msg-${index}`, role: "user", content: `content-${index}` });
  }
  assert.equal(cache._tokenEntries.size, 2048);
  assert.match(String(cache._tokenEntries.keys().next().value), /^msg-952:/);
  assert.ok(cache.exportTokenState().entries.length <= cache._tokenEntries.size);
});

test("token entries restored from state are trimmed to the bound", () => {
  const entries = Array.from({ length: 5000 }, (_, index) => ({ key: `seeded-${index}`, size: index + 1 }));
  const cache = new ContextCache({ entries });
  assert.ok(cache._tokenEntries.size <= 2048);
  assert.equal(cache.exportTokenState().entries.length, Math.min(2000, cache._tokenEntries.size));
});

test("evicted entries are recomputed instead of served stale", () => {
  const cache = new ContextCache();
  const message = { id: "first", role: "user", content: "a".repeat(40) };
  const meta = cache.messageMeta(message);
  for (let index = 0; index < 2048; index++) {
    cache.messageMeta({ id: `fill-${index}`, role: "user", content: "filler" });
  }
  assert.equal(cache._tokenEntries.has(meta.key), false);
  const recomputed = cache.messageMeta(message);
  assert.equal(recomputed.size, meta.size);
  assert.ok(cache._tokenEntries.size <= 2048);
});
