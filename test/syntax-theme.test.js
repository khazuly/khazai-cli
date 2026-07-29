import assert from "node:assert/strict";
import test from "node:test";
import { THEMES, THEME_NAMES, resolveTheme } from "../ui/theme.js";

test("unified theme list includes all syntax themes", () => {
  assert.ok(THEME_NAMES.includes("catppuccin-frappe"));
  assert.ok(THEME_NAMES.includes("catppuccin-latte"));
  assert.ok(THEME_NAMES.includes("catppuccin-macchiato"));
  assert.ok(THEME_NAMES.includes("catppuccin-mocha"));
  assert.ok(THEME_NAMES.includes("dracula"));
  assert.ok(THEME_NAMES.includes("monokai-extended-bright"));
  assert.ok(THEME_NAMES.includes("monokai-extended-light"));
  assert.ok(THEME_NAMES.includes("solarized-dark"));
  assert.ok(THEME_NAMES.includes("solarized-light"));
  assert.ok(THEME_NAMES.includes("sublime-snazzy"));
  assert.ok(THEME_NAMES.includes("two-dark"));
  assert.ok(THEME_NAMES.includes("monokai"));
});

test("unified themes supply semantic and syntax colors", () => {
  const dark = THEMES["catppuccin-mocha"];
  const light = THEMES["solarized-light"];

  for (const palette of [dark, light]) {
    // Required canonical fields
    for (const key of ["name", "background", "text", "muted", "subtle", "border", "borderActive", "primary", "secondary", "success", "warning", "error", "info", "user", "assistant", "toolRead", "toolSearch", "toolShell", "toolWrite", "toolEdit", "code"]) {
      assert.ok(key in palette, `Missing field "${key}" in ${palette.name}`);
    }
    // Syntax palette
    for (const key of ["keyword", "type", "function", "string", "addedBackground", "deletedBackground"]) {
      assert.match(palette.syntax[key], /^#[0-9a-f]{6}$/i, `Bad syntax.${key} in ${palette.name}`);
    }
  }
  assert.notEqual(dark.syntax.keyword, light.syntax.keyword);
});

test("resolveTheme returns the requested unified theme", () => {
  const themed = resolveTheme("light", {});
  const mono = resolveTheme("mono", {});

  assert.equal(themed.name, "light");
  assert.equal(themed.colorEnabled, true);
  assert.equal(mono.name, "mono");
  assert.equal(mono.colorEnabled, false);
});

test("resolveTheme with NO_COLOR returns mono", () => {
  const themed = resolveTheme("dracula", { NO_COLOR: "1" });
  assert.equal(themed.name, "mono");
  assert.equal(themed.colorEnabled, false);
});

test("unknown theme falls back to system", () => {
  const theme = resolveTheme("nonexistent", {});
  assert.equal(theme.name, "system");
});
