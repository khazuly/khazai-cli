import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULTS } from "./defaults.js";

const CONFIG_DIR = join(homedir(), ".config", "khazai-ai");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const PROJECT_FILES = [".khazai-ai.json", ".khazai-airc"];

function loadJSON(path) {
  try { return JSON.parse(readFileSync(path, "utf-8")); }
  catch { return null; }
}

export function loadConfig() {
  const config = { ...DEFAULTS };
  const global = loadJSON(CONFIG_PATH);
  if (global) Object.assign(config, global);
  const cwd = process.cwd();
  for (const name of PROJECT_FILES) {
    const p = resolve(cwd, name);
    if (existsSync(p)) { const local = loadJSON(p); if (local) Object.assign(config, local); break; }
  }
  return config;
}

export function findProjectInstructions() {
  const cwd = process.cwd();
  for (const name of ["AGENTS.md", "CLAUDE.md", "KHAZAI.md"]) {
    const p = resolve(cwd, name);
    if (existsSync(p)) { try { return readFileSync(p, "utf-8"); } catch { return null; } }
  }
  return null;
}
