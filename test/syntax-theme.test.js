import assert from "node:assert/strict";
import test from "node:test";
import { isSyntaxTheme, normalizeSyntaxTheme, SYNTAX_THEMES, syntaxThemeColors } from "../ui/syntax-theme.js";
import { resolveTheme } from "../ui/theme.js";

test("syntax theme picker uses the Codex built-in theme choices", () => {
  assert.deepEqual(SYNTAX_THEMES.map(([id]) => id), [
    "catppuccin-frappe",
    "catppuccin-latte",
    "catppuccin-macchiato",
    "catppuccin-mocha",
    "dracula",
    "monokai-extended-bright",
    "monokai-extended-light",
    "solarized-dark",
    "solarized-light",
    "sublime-snazzy",
    "two-dark",
  ]);
  assert.equal(isSyntaxTheme("dracula"), true);
  assert.equal(normalizeSyntaxTheme("dark"), "catppuccin-mocha");
  assert.equal(resolveTheme("solarized-light", {}).syntaxTheme, "solarized-light");
});

test("syntax themes supply semantic and diff colors", () => {
  const dark = syntaxThemeColors("catppuccin-mocha");
  const light = syntaxThemeColors("solarized-light");

  for (const palette of [dark, light]) {
    for (const key of ["keyword", "type", "function", "string", "addedBackground", "deletedBackground"]) {
      assert.match(palette[key], /^#[0-9a-f]{6}$/i);
    }
  }
  assert.notEqual(dark.keyword, light.keyword);
});

test("syntax theme remains independent from the interface theme", () => {
  const themed = resolveTheme("light", {}, "dracula");
  const mono = resolveTheme("mono", {}, "dracula");

  assert.equal(themed.name, "light");
  assert.equal(themed.syntaxTheme, "dracula");
  assert.equal(themed.syntax.keyword, syntaxThemeColors("dracula").keyword);
  assert.equal(mono.colorEnabled, false);
});
