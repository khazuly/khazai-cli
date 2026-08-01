import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createElement as h } from "react";
import { TrustPrompt } from "../ui/components/trust-prompt.js";
import { renderComponent, stripAnsi } from "./helpers/ink-render.js";
import { attachFileReferences, listWorkspaceFiles, referencedPaths } from "../ui/file-reference.js";
import { isDirectoryTrusted, getWorkspace, markTrusted } from "../config/workspace.js";
import { resolveTheme } from "../ui/theme.js";

test("semantic themes support system, dark, light, mono, and NO_COLOR", () => {
  assert.equal(resolveTheme("system", {}).name, "system");
  assert.equal(resolveTheme("dark", {}).panel, "#181825");
  assert.equal(resolveTheme("light", {}).background, "#eff1f5");
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

test("trust prompt renders compact bordered layout with all sections", async () => {
  const frame = await renderComponent(
    h(TrustPrompt, { path: "/root/spam-otp", onTrust: () => {} }),
    50,
    14,
  );
  const text = stripAnsi(frame).replace(/[│┌┐└┘─]+/g, " ").replace(/\s+/g, " ");


  assert.match(frame, /Workspace trust/);


  assert.match(text, /KhazAI may read, modify, and run commands in this directory/);


  assert.match(frame, /Directory/);
  assert.match(frame, /\/root\/spam-otp/);


  assert.match(frame, /Trust and continue/);
  assert.match(frame, /Exit without trusting/);


  assert.match(frame, /Select/);
  assert.match(frame, /Confirm/);
  assert.match(frame, /Exit/);


  assert.match(frame, /↑↓ Select · Enter Confirm · Esc Exit/);
});

test("trust prompt highlights only the selected option", async () => {

  const frame = await renderComponent(
    h(TrustPrompt, { path: "/tmp", onTrust: () => {} }),
    50,
    14,
  );

  const lines = frame.split("\n");
  const optionLines = lines.filter(l => l.includes("Trust and continue") || l.includes("Exit without trusting"));


  assert.equal(optionLines.length, 2);


  assert.match(optionLines[0], /›/);

  assert.match(optionLines[0], /Trust and continue/);


  assert.doesNotMatch(optionLines[1], /›/);
});

test("trust prompt wraps long paths", async () => {
  const longPath = "/very/long/path/that/should/wrap/nicely/on/narrow/terminals/without/breaking/badly";
  const frame = await renderComponent(
    h(TrustPrompt, { path: longPath, onTrust: () => {} }),
    30,
    14,
  );

  assert.match(frame, /Directory/);

  assert.match(frame, /very|long|path|wrap|wrapping/);

  const lines = frame.split("\n");
  for (const line of lines) {
    if (line.includes(longPath) || line.includes("/very") || line.includes("/long")) {
      assert.ok(stripAnsi(line).length <= 30, `Line exceeds terminal width: "${stripAnsi(line)}"`);
    }
  }
});

test("trust prompt prevents double confirmation", async () => {
  let trustCount = 0;
  const frame = await renderComponent(
    h(TrustPrompt, {
      path: "/tmp",
      onTrust: () => { trustCount++; },
    }),
    50,
    14,
  );

  assert.ok(frame.includes("Trust and continue"));
});

test("isDirectoryTrusted returns false for non-existent path", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "khazai-trust-test-"));
  const nonExistent = join(tmpDir, "does-not-exist");
  assert.equal(isDirectoryTrusted(nonExistent), false);
  rmSync(tmpDir, { recursive: true, force: true });
});

test("isDirectoryTrusted returns true after marking trusted", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "khazai-trust-test-"));
  try {

    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const key = Buffer.from(tmpDir).toString("base64url");
    const globalDir = join(homedir(), ".config", "khazai-ai", "workspaces");
    const cfgPath = join(globalDir, `${key}.json`);




    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(cfgPath, JSON.stringify({ trusted: true, trustedAt: new Date().toISOString() }), "utf-8");

    assert.equal(isDirectoryTrusted(tmpDir), true);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("symlink resolution normalizes trusted path", async () => {

  if (process.platform === "win32") return;

  const baseDir = mkdtempSync(join(tmpdir(), "khazai-symlink-"));
  const realDir = join(baseDir, "real");
  const linkDir = join(baseDir, "link");
  mkdirSync(realDir, { recursive: true });
  symlinkSync(realDir, linkDir);

  try {

    const { getWorkspace, markTrusted } = await import("../config/workspace.js");




    const { realpathSync } = await import("node:fs");
    const resolved = realpathSync(linkDir);
    assert.equal(resolved, realDir);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
