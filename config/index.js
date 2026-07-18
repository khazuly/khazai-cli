import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULTS } from "./defaults.js";

const CONFIG_DIR = join(homedir(), ".config", "khazai-ai");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const PROJECT_FILES = [".khazai-ai.json", ".khazai-airc"];
const MODEL = "big-cock";
const MODEL_ALIASES = new Set([MODEL, "cock"]);

export function normalizeModel(model) {
  const value = String(model || "").toLowerCase();
  if (MODEL_ALIASES.has(value) || !value) return MODEL;
  return value.includes("/") ? String(model) : MODEL;
}

function loadJSON(path) {
  try { return JSON.parse(readFileSync(path, "utf-8")); }
  catch { return null; }
}

export function loadConfig(workspace = process.cwd()) {
  const config = { ...DEFAULTS };
  const global = loadJSON(CONFIG_PATH);
  if (global) Object.assign(config, global);
  config._permissionLayers = global?.permission === undefined ? [] : [global.permission];
  const cwd = resolve(workspace);
  for (const name of PROJECT_FILES) {
    const p = resolve(cwd, name);
    if (existsSync(p)) {
      const local = loadJSON(p);
      if (local) {
        Object.assign(config, local);
        config.providers = { ...(global?.providers || {}), ...(local.providers || {}) };
        config.mcp = { ...(global?.mcp || {}), ...(local.mcp || {}) };
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
