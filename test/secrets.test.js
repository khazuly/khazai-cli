import assert from "node:assert/strict";
import test from "node:test";
import { redactSerializable, redactSecrets } from "../lib/secrets.js";

test("redactSerializable does not throw on circular structures", () => {
  const value = { name: "root" };
  value.self = value;
  const list = [value];
  list.push(list);
  const safe = redactSerializable({ value, list });
  assert.equal(safe.value.name, "root");
  assert.equal(safe.value.self, undefined);
  assert.doesNotMatch(JSON.stringify(safe), /"self"/);
});

test("redactSerializable converts BigInt values without throwing", () => {
  const safe = redactSerializable({ count: 10n, nested: { big: 9007199254740993n } });
  assert.equal(safe.count, "10");
  assert.equal(safe.nested.big, "9007199254740993");
  assert.doesNotThrow(() => JSON.stringify(safe));
});

test("redactSerializable converts non-finite numbers to null", () => {
  const safe = redactSerializable({ a: NaN, b: Infinity, c: -Infinity });
  assert.deepEqual(safe, { a: null, b: null, c: null });
});

test("redactSerializable keeps dates as ISO strings and drops functions", () => {
  const date = new Date("2026-01-02T03:04:05.000Z");
  const safe = redactSerializable({ at: date, fn: () => {}, kept: "x" });
  assert.equal(safe.at, "2026-01-02T03:04:05.000Z");
  assert.deepEqual(Object.keys(safe).sort(), ["at", "kept"]);
});

test("redactSerializable still redacts secrets and stays JSON-safe", () => {
  const token = "ghp_123456789012345678901234567890123456";
  const safe = redactSerializable({ token, nested: { line: `token: ${token}` } });
  assert.doesNotMatch(JSON.stringify(safe), /ghp_/);
  assert.match(safe.token, /\[REDACTED\]/);
  assert.match(safe.nested.line, /\[REDACTED\]/);
  assert.doesNotThrow(() => JSON.stringify(safe));
});

test("redactSecrets strips labeled credentials", () => {
  const text = "password=hunter2 token: abcdefghijklmnopqrstuvwxyz";
  assert.doesNotMatch(redactSecrets(text), /hunter2|abcdefghijklmnopqrstuvwxyz/);
});
