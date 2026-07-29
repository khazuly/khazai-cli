import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { resolve, join, normalize } from "node:path";
import { homedir } from "node:os";

const GLOBAL_DIR = join(homedir(), ".config", "khazai-ai", "workspaces");

function realPath(p) {
  try {
    return realpathSync(p);
  } catch {
    return normalize(resolve(p));
  }
}

function workspaceKey(cwd) {
  return Buffer.from(cwd).toString("base64url");
}

function workspaceConfigPath(cwd) {
  return join(GLOBAL_DIR, `${workspaceKey(cwd)}.json`);
}

export function getWorkspace() {
  const raw = process.cwd();
  const resolved = realPath(raw);
  const cfgPath = workspaceConfigPath(resolved);
  let trusted = false;

  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      trusted = cfg.trusted === true;
    } catch {}
  }

  return { path: resolved, rawPath: raw, trusted, cfgPath };
}

export function markTrusted(cfgPath) {
  mkdirSync(GLOBAL_DIR, { recursive: true });
  writeFileSync(
    cfgPath,
    JSON.stringify({ trusted: true, trustedAt: new Date().toISOString() }, null, 2),
    "utf-8"
  );
}

export function isDirectoryTrusted(dirPath) {
  const resolved = realPath(dirPath);
  const cfgPath = workspaceConfigPath(resolved);
  if (!existsSync(cfgPath)) return false;
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    return cfg.trusted === true;
  } catch {
    return false;
  }
}

export function resolveWorkspacePath(userPath) {
  const ws = getWorkspace();
  return resolve(ws.path, userPath);
}
