import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createElement as h } from "react";
import { render } from "ink";
import { SessionFooter } from "../ui/components/session-footer.js";
import { PromptInput } from "../ui/components/prompt-input.js";
import { COMMANDS } from "../ui/commands.js";
import {
  renderComponent,
  TerminalInput,
  TerminalOutput,
} from "./helpers/ink-render.js";

const root = dirname(dirname(new URL(import.meta.url).pathname));
const configModule = pathToFileURL(join(root, "config", "index.js")).href;
const settingsModule = pathToFileURL(join(root, "config", "model-settings.js")).href;
const agentModule = pathToFileURL(join(root, "app", "agent.js")).href;
const registryModule = pathToFileURL(join(root, "app", "registry.js")).href;

function isolatedRun(home, source) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: home,
    env: { ...process.env, HOME: home },
    encoding: "utf-8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) return false;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return true;
}

test("model context settings persist and refresh the active agent", () => {
  const home = mkdtempSync(join(tmpdir(), "khazai-settings-"));
  const workspace = join(home, "workspace");
  mkdirSync(workspace);
  const output = isolatedRun(home, `
    import assert from "node:assert/strict";
    import { loadConfig } from ${JSON.stringify(configModule)};
    import { saveModelSettings, resolveEffectiveSettings } from ${JSON.stringify(settingsModule)};
    import { Agent } from ${JSON.stringify(agentModule)};
    import { Registry } from ${JSON.stringify(registryModule)};
    saveModelSettings("big-cock", { contextLimit: 128000, compactionThreshold: 0.85 });
    const effective = resolveEffectiveSettings("big-cock");
    assert.equal(effective.contextLimit, 128000);
    assert.equal(effective.contextLimitSource, "config");
    const agent = new Agent(new Registry(), { workspace: ${JSON.stringify(workspace)}, model: "big-cock" });
    const usage = agent.contextUsage();
    assert.equal(usage.contextLimit, 128000);
    assert.equal(usage.contextLimitSource, "config");
    assert.equal(agent._config.compactThreshold, 0.85);
    saveModelSettings("big-cock", { contextLimit: 64000, compactionThreshold: 0.8 });
    const refreshed = agent.refreshEffectiveSettings();
    assert.equal(refreshed.usage.contextLimit, 64000);
    assert.equal(agent._config.compactThreshold, 0.8);
    saveModelSettings("big-cock", { contextLimit: null });
    assert.equal(resolveEffectiveSettings("big-cock").contextLimit, null);
    assert.equal(loadConfig(${JSON.stringify(workspace)}).modelSettings["big-cock"].contextLimit, undefined);
    process.stdout.write("ok");
  `);
  assert.equal(output, "ok");
});

test("canonical theme survives preview cancellation and process restart", () => {
  const home = mkdtempSync(join(tmpdir(), "khazai-theme-"));
  const configPath = join(home, ".config", "khazai-ai", "config.json");
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({
    theme: "dark",
    syntaxTheme: "light",
    modelSettings: { "big-cock": { contextLimit: 128000 } },
  }));
  isolatedRun(home, `
    import assert from "node:assert/strict";
    import { loadConfig, saveTheme } from ${JSON.stringify(configModule)};
    assert.equal(loadConfig(${JSON.stringify(home)}).theme, "dark");
    await saveTheme("dracula");
    assert.equal(loadConfig(${JSON.stringify(home)}).theme, "dracula");
  `);
  const persisted = JSON.parse(readFileSync(configPath, "utf-8"));
  assert.equal(persisted.theme, "dracula");
  assert.equal(persisted.syntaxTheme, undefined);
  assert.equal(persisted.modelSettings["big-cock"].contextLimit, 128000);
  assert.equal(isolatedRun(home, `
    import { loadConfig } from ${JSON.stringify(configModule)};
    process.stdout.write(loadConfig(${JSON.stringify(home)}).theme);
  `), "dracula");
});

test("leaving the theme selector identifies the preview being cancelled", async () => {
  const stdin = new TerminalInput();
  const stdout = new TerminalOutput(80, 20);
  const previews = [];
  const exits = [];
  const instance = render(h(PromptInput, {
    commands: COMMANDS,
    onCommand() {},
    onSubmit() {},
    onPreviewChange(command, value) {
      previews.push([command, value]);
    },
    onExitSub(command) {
      exits.push(command);
    },
  }), { stdin, stdout, debug: false, patchConsole: false, exitOnCtrlC: false });
  stdin.push("/theme ");
  assert.equal(await waitFor(() => previews.length > 0), true);
  stdin.push("\u001b");
  assert.equal(await waitFor(() => exits.length > 0), true);
  assert.equal(previews[0]?.[0], "/theme");
  assert.deepEqual(exits, ["/theme"]);
  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});

test("footer renders the effective configured context limit", async () => {
  const frame = await renderComponent(h(SessionFooter, {
    model: "big-cock",
    contextUsage: {
      currentContextTokens: 88_200,
      contextLimit: 128_000,
      contextLimitKnown: true,
      contextLimitSource: "config",
      usagePercent: 68.90625,
    },
    promptProps: { onSubmit() {}, onCommand() {}, commands: [] },
  }), 80, 12);
  assert.match(frame, /Context 88\.2k \/ 128k · 69%/);
  assert.doesNotMatch(frame, /Limit unknown/);
});
