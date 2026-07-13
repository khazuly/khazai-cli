import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

const GLOBAL_DIR = join(homedir(), ".config", "khazai-ai", "workspaces");

function workspaceKey(cwd) {
  return Buffer.from(cwd).toString("base64url");
}

function workspaceConfigPath(cwd) {
  return join(GLOBAL_DIR, `${workspaceKey(cwd)}.json`);
}

export function getWorkspace() {
  const cwd = process.cwd();
  const cfgPath = workspaceConfigPath(cwd);
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
  mkdirSync(GLOBAL_DIR, { recursive: true });
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
