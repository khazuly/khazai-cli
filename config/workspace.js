import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";

const CONFIG_DIR = ".khazai-ai";
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export function getWorkspace() {
  const cwd = process.cwd();
  const cfgPath = resolve(cwd, CONFIG_PATH);
  let trusted = false;

  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      trusted = cfg.trusted === true;
    } catch {}
  }

  return { path: cwd, trusted, cfgPath };
}

export function markTrusted(cfgPath) {
  mkdirSync(resolve(process.cwd(), CONFIG_DIR), { recursive: true });
  writeFileSync(
    cfgPath,
    JSON.stringify({ trusted: true, trustedAt: new Date().toISOString() }, null, 2),
    "utf-8"
  );
}

export function resolveWorkspacePath(userPath) {
  const ws = getWorkspace();
  return resolve(ws.path, userPath);
}
