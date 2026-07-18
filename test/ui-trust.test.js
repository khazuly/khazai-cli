import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { attachFileReferences, listWorkspaceFiles, referencedPaths } from "../ui/file-reference.js";
import { resolveTheme } from "../ui/theme.js";

test("semantic themes support system, dark, light, mono, and NO_COLOR", () => {
  assert.equal(resolveTheme("system", {}).name, "system");
  assert.equal(resolveTheme("dark", {}).panel, "#0f0f10");
  assert.equal(resolveTheme("light", {}).background, "#ffffff");
  assert.equal(resolveTheme("mono", {}).colorEnabled, false);
  assert.equal(resolveTheme("dark", { NO_COLOR: "1" }).name, "mono");
});

test("workspace file references are bounded, ignore dependencies, and attach safe text files", () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-file-reference-"));
  mkdirSync(join(workspace, "src"), { recursive: true });
  mkdirSync(join(workspace, "node_modules", "hidden"), { recursive: true });
  writeFileSync(join(workspace, "src", "auth.js"), "export const auth = true;\n");
  writeFileSync(join(workspace, "node_modules", "hidden", "index.js"), "hidden\n");

  assert.deepEqual(listWorkspaceFiles(workspace), ["src/auth.js"]);
  assert.deepEqual(referencedPaths("explain @src/auth.js and @src/auth.js"), ["src/auth.js"]);
  const attached = attachFileReferences("explain @src/auth.js", workspace);
  assert.match(attached, /\[Referenced file: src\/auth\.js\]/);
  assert.match(attached, /export const auth = true/);
  assert.equal(attachFileReferences("read @../outside.txt", workspace), "read @../outside.txt");
});
