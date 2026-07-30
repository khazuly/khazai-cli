import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const GLOBAL_CONFIG_PATH = join(homedir(), ".config", "khazai-ai", "config.json");

let revision = 0;
let temporarySequence = 0;
const listeners = new Set();

export function readConfigFile(path = GLOBAL_CONFIG_PATH) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

export function updateConfigFile(update, {
  path = GLOBAL_CONFIG_PATH,
  reason = "config",
} = {}) {
  const target = resolve(path);
  const current = readConfigFile(target);
  const next = update({ ...current }) || current;
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${++temporarySequence}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    renameSync(temporary, target);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {}
    throw error;
  }
  if (target === resolve(GLOBAL_CONFIG_PATH)) {
    revision++;
    const event = { revision, reason, config: next };
    for (const listener of listeners) listener(event);
  }
  return next;
}

export function configRevision() {
  return revision;
}

export function subscribeConfig(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
