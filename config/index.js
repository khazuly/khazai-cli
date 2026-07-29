import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULTS } from "./defaults.js";
import { isSyntaxTheme, normalizeSyntaxTheme } from "../ui/syntax-theme.js";

const CONFIG_DIR = join(homedir(), ".config", "khazai-ai");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const PROJECT_FILES = [".khazai-ai.json", ".khazai-airc"];
const OPENCODE_CONFIG_DIR = join(homedir(), ".config", "opencode");
const OPENCODE_GLOBAL_FILES = ["opencode.json", "opencode.jsonc"];
const OPENCODE_PROJECT_FILES = ["opencode.json", "opencode.jsonc"];
const MODEL = "big-cock";
const AUTO_FREE_MODEL = "auto-free";
const MODEL_ALIASES = new Set([MODEL, "cock", "gpt", AUTO_FREE_MODEL]);

export function normalizeModel(model) {
  const value = String(model || "").toLowerCase();
  if (!value) return MODEL;
  if (value === AUTO_FREE_MODEL) return AUTO_FREE_MODEL;
  if (MODEL_ALIASES.has(value)) return MODEL;
  return String(model);
}

function loadJSON(path) {
  try { return JSON.parse(readFileSync(path, "utf-8")); }
  catch { return null; }
}

function stripJsonComments(source) {
  let result = "";
  let quote = "";
  for (let index = 0; index < source.length; index++) {
    const current = source[index];
    const next = source[index + 1];
    if (quote) {
      result += current;
      if (current === "\\") result += source[++index] || "";
      else if (current === quote) quote = "";
      continue;
    }
    if (current === '"') { quote = current; result += current; continue; }
    if (current === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index++;
      result += "\n";
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (index < source.length && (source[index] !== "*" || source[index + 1] !== "/")) index++;
      index++;
      continue;
    }
    result += current;
  }
  return result.replace(/,(\s*[}\]])/g, "$1");
}

function loadJSONC(path) {
  try { return JSON.parse(stripJsonComments(readFileSync(path, "utf-8"))); }
  catch { return null; }
}

function loadFirst(paths, loader) {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const config = loader(path);
    if (config) return config;
  }
  return null;
}

function openCodeMcp(workspace) {
  const global = loadFirst(OPENCODE_GLOBAL_FILES.map(name => join(OPENCODE_CONFIG_DIR, name)), loadJSONC);
  const project = loadFirst(OPENCODE_PROJECT_FILES.map(name => join(resolve(workspace), name)), loadJSONC);
  return { ...(global?.mcp || {}), ...(project?.mcp || {}) };
}

export function loadConfig(workspace = process.cwd()) {
  const config = { ...DEFAULTS };
  const openCodeMcpConfig = openCodeMcp(workspace);
  const global = loadJSON(CONFIG_PATH);
  if (global) Object.assign(config, global);
  config.mcp = { ...openCodeMcpConfig, ...(global?.mcp || {}) };
  config._permissionLayers = global?.permission === undefined ? [] : [global.permission];
  const cwd = resolve(workspace);
  for (const name of PROJECT_FILES) {
    const p = resolve(cwd, name);
    if (existsSync(p)) {
      const local = loadJSON(p);
      if (local) {
        Object.assign(config, local);
        config.providers = { ...(global?.providers || {}), ...(local.providers || {}) };
        config.mcp = { ...openCodeMcpConfig, ...(global?.mcp || {}), ...(local.mcp || {}) };
        config.permission = local.permission ?? global?.permission ?? {};
        if (local.permission !== undefined) config._permissionLayers.push(local.permission);
        if (
          global?.web && typeof global.web === "object" && !Array.isArray(global.web)
          && local.web && typeof local.web === "object" && !Array.isArray(local.web)
        ) {
          config.web = {
            ...global.web,
            ...local.web,
            search: { ...(global.web.search || {}), ...(local.web.search || {}) },
          };
        }
        if (
          global?.lsp && typeof global.lsp === "object" && !Array.isArray(global.lsp)
          && local.lsp && typeof local.lsp === "object" && !Array.isArray(local.lsp)
        ) {
          config.lsp = { ...global.lsp, ...local.lsp };
        }
      }
      break;
    }
  }
  config.model = normalizeModel(config.model);
  return config;
}

export function saveModel(model) {
  const normalized = normalizeModel(model);
  const config = loadJSON(CONFIG_PATH) || {};
  config.model = normalized;
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function saveReasoningEffort(effort) {
  const value = String(effort || "").toLowerCase();
  if (!["low", "medium", "high", "xhigh"].includes(value)) throw new Error(`Unknown reasoning effort "${effort}".`);
  const config = loadJSON(CONFIG_PATH) || {};
  config.reasoningEffort = value;
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return value;
}

export function saveTheme(theme) {
  const value = String(theme || "").toLowerCase();
  if (!["system", "dark", "light", "mono"].includes(value)) {
    throw new Error(`Unknown theme "${theme}".`);
  }
  const config = loadJSON(CONFIG_PATH) || {};
  config.theme = value;
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return value;
}

export function saveSyntaxTheme(theme) {
  if (!isSyntaxTheme(theme)) throw new Error(`Unknown syntax theme "${theme}".`);
  const config = loadJSON(CONFIG_PATH) || {};
  config.syntaxTheme = normalizeSyntaxTheme(theme);
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return config.syntaxTheme;
}

export function saveProvider(id, provider) {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(String(id || ""))) throw new Error("Invalid provider ID.");
  const config = loadJSON(CONFIG_PATH) || {};
  config.providers = { ...(config.providers || {}), [id]: { ...provider } };
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function configuredModels() {
  const config = loadConfig();
  return [
    MODEL,
    AUTO_FREE_MODEL,
    ...Object.entries(config.providers || {}).flatMap(([provider, value]) =>
      (value.models || []).map(model => `${provider}/${model}`)),
  ];
}

export function findProjectInstructions() {
  const cwd = process.cwd();
  for (const name of ["CLAUDE.md", "KHAZAI.md"]) {
    const p = resolve(cwd, name);
    if (existsSync(p)) { try { return readFileSync(p, "utf-8"); } catch { return null; } }
  }
  return null;
}
