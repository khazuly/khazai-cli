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

function readAuthContent(value) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return {};
  }
}

function openCodeCredential(auth) {
  const entry = auth?.opencode;
  if (!entry || typeof entry !== "object") return "";
  return String(entry.key || entry.apiKey || entry.token || entry.value || "").trim();
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

export function getOpenCodeCredential(
  path = join(homedir(), ".local", "share", "opencode", "auth.json"),
  environment = process.env,
) {
  const inherited = openCodeCredential(readAuthContent(environment.OPENCODE_AUTH_CONTENT));
  if (inherited) return inherited;
  const value = openCodeCredential(readAuth(path));
  if (value) return value;
  const khazaiAuthPath = join(homedir(), ".local", "share", "khazai-ai", "auth.json");
  return openCodeCredential(readAuth(khazaiAuthPath));
}

export function getProviderAuth(providerId, path = AUTH_PATH) {
  const value = readAuth(path)[providerId];
  return value && typeof value === "object" ? value : null;
}

export function saveProviderCredential(providerId, apiKey, path = AUTH_PATH) {
  return saveCredential(providerId, apiKey, path);
}

export function saveProviderAuth(providerId, value, path = AUTH_PATH) {
  if (!providerId || !value || typeof value !== "object") throw new Error("Provider authentication is required.");
  const auth = readAuth(path);
  auth[providerId] = { ...value, updatedAt: new Date().toISOString() };
  atomicWrite(path, auth);
  return path;
}

export function removeProviderCredential(providerId, path = AUTH_PATH) {
  return removeCredential(providerId, path);
}

export function getCredential(id, envName, path = AUTH_PATH) {
  if (envName && process.env[envName]) return process.env[envName];
  return readAuth(path)[id]?.apiKey || "";
}

export function saveCredential(id, value, path = AUTH_PATH) {
  if (!id || !value) throw new Error("API key and value are required.");
  const auth = readAuth(path);
  auth[id] = { apiKey: value, updatedAt: new Date().toISOString() };
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
