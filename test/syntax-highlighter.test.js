import assert from "node:assert/strict";
import test from "node:test";
import { highlightBlock, highlightLine, resolveLanguage } from "../lib/syntax-highlighter.js";

test("syntax highlighter distinguishes GitHub Dark semantic token categories", () => {
  const javascript = highlightLine('class Widget { render(value) { return "ok" + 42; } }', "javascript");
  const colors = new Set(javascript.map(part => part.color));

  assert.ok(colors.has("type"));
  assert.ok(colors.has("function"));
  assert.ok(colors.has("keyword"));
  assert.ok(colors.has("string"));
  assert.ok(colors.has("number"));
});

test("syntax highlighter resolves supported aliases and falls back safely", () => {
  assert.equal(resolveLanguage("py"), "python");
  assert.equal(resolveLanguage("tsx"), "tsx");
  assert.equal(resolveLanguage("unknown-language"), null);
  assert.deepEqual(highlightLine("plain text", "unknown-language"), [{ text: "plain text", color: "text" }]);
});

test("syntax highlighter supports common additional language aliases", () => {
  for (const [alias, language] of [
    ["c++", "cpp"], ["cs", "csharp"], ["dockerfile", "docker"], ["kt", "kotlin"], ["terraform", "hcl"],
  ]) {
    assert.equal(resolveLanguage(alias), language);
  }
});

test("syntax highlighter preserves tokens across multiline code", () => {
  const rows = highlightBlock("const greeting = `hello\n${name}`;", "javascript");
  assert.equal(rows.length, 2);
  assert.ok(rows[0].some(part => part.color === "string"));
  assert.ok(rows[1].some(part => part.color === "string"));
});
