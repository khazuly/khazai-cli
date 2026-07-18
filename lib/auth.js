import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const AUTH_PATH = join(homedir(), ".local", "share", "khazai-ai", "auth.json");

function readAuth(path = AUTH_PATH) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function getProviderCredential(providerId, envName, path = AUTH_PATH) {
  return getCredential(providerId, envName, path);
}

export function saveProviderCredential(providerId, apiKey, path = AUTH_PATH) {
  return saveCredential(providerId, apiKey, path);
}

export function removeProviderCredential(providerId, path = AUTH_PATH) {
  return removeCredential(providerId, path);
}

export function getCredential(id, envName, path = AUTH_PATH) {
  if (envName && process.env[envName]) return process.env[envName];
  return readAuth(path)[id]?.apiKey || "";
}

export function saveCredential(id, value, path = AUTH_PATH) {
  if (!id || !value) throw new Error("Credential ID and value are required.");
  const auth = readAuth(path);
  auth[id] = { apiKey: String(value), updatedAt: new Date().toISOString() };
  atomicWrite(path, auth);
  return path;
}

export function removeCredential(id, path = AUTH_PATH) {
  if (!existsSync(path)) return false;
  const auth = readAuth(path);
  if (!Object.hasOwn(auth, id)) return false;
  delete auth[id];
  atomicWrite(path, auth);
  return true;
}
