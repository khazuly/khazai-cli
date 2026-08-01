import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const DEFAULT_PERMISSIONS = {
  "*": "allow",
  external_directory: "ask",
  read: {
    "*": "allow",
    "*.env": "deny",
    "*.env.*": "deny",
    "*.env.example": "allow",
  },
};

export class PermissionRejectedError extends Error {
  constructor(permission, pattern) {
    super(`Permission rejected: ${permission} (${pattern})`);
    this.name = "PermissionRejectedError";
    this.permission = permission;
    this.pattern = pattern;
  }
}

export function readJSON(path) {
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}

export const PERMISSION_STORE_VERSION = 1;
export const PERMISSION_STORE_DIR = join(homedir(), ".local", "share", "khazai-ai", "permissions");

export function workspaceStoreKey(workspace) {
  return createHash("sha256").update(resolve(workspace)).digest("hex").slice(0, 24);
}

export function canonicalPath(value, workspace) {
  const resolved = resolve(workspace, expandHome(value));
  try {
    return realpathSync(resolved);
  } catch {}
  try {
    return join(realpathSync(dirname(resolved)), basename(resolved));
  } catch {
    return resolved;
  }
}

export function isDirectoryPath(value) {
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
}

export function atomicWriteStore(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function expandHome(value) {
  const source = String(value || "");
  if (source === "~" || source === "$HOME") return homedir();
  if (source.startsWith("~/")) return join(homedir(), source.slice(2));
  if (source.startsWith("$HOME/")) return join(homedir(), source.slice(6));
  return source;
}

function wildcard(pattern, value) {
  const expression = expandHome(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${expression}$`, "i").test(expandHome(value));
}

export function permissionName(toolName) {
  return ["write", "edit", "apply_patch"].includes(toolName) ? "edit" : toolName;
}

function shellSegments(command) {
  return String(command || "")
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map(value => value.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

export function actionValues(toolName, args = {}) {
  if (toolName === "bash") return shellSegments(args.command);
  if (toolName === "webfetch") return [String(args.url || "")];
  if (toolName === "websearch") return [String(args.query || "")];
  if (toolName === "glob") return [String(args.pattern || "*")];
  if (toolName === "grep") return [String(args.pattern || "*")];
  if (toolName === "apply_patch") {
    const paths = [...String(args.patchText || "").matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)]
      .map(match => match[1]);
    return paths.length ? paths : ["*"];
  }
  if (toolName === "skill") return [String(args.name || "")];
  if (toolName === "task") return [String(args.subagent_type || args.agent || args.description || "*")];
  if (args.path) return [String(args.path)];
  return ["*"];
}

function normalizePermissionConfig(value) {
  if (["allow", "ask", "deny"].includes(value)) return { "*": value };
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  if (Object.hasOwn(value, "write") && !Object.hasOwn(value, "edit")) {
    return { ...value, edit: value.write };
  }
  return value;
}

export function rulesFromLayer(layer) {
  const normalized = normalizePermissionConfig(layer);
  const rules = [];
  for (const [permission, value] of Object.entries(normalized)) {
    if (["allow", "ask", "deny"].includes(value)) {
      rules.push({ permission, pattern: "*", action: value });
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [pattern, action] of Object.entries(value)) {
      if (["allow", "ask", "deny"].includes(action)) rules.push({ permission, pattern, action });
    }
  }
  return rules;
}

function matchesPermission(rule, permission) {
  return wildcard(rule.permission, permission);
}

export function resolveAction(rules, permission, value) {
  let matched = null;
  for (const rule of rules) {
    if (matchesPermission(rule, permission) && wildcard(rule.pattern, value)) matched = rule;
  }
  return matched;
}

export function outside(path, workspace) {
  const target = resolve(workspace, expandHome(path));
  const rel = relative(resolve(workspace), target);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? target : null;
}

function systemMutationPath(path, workspace) {
  const target = resolve(workspace, expandHome(path));
  return ["/bin", "/boot", "/dev", "/etc", "/proc", "/sbin", "/sys", "/usr"]
    .some(root => target === root || target.startsWith(`${root}${sep}`));
}

function shellTokens(command) {
  const tokens = [];
  let word = "";
  let quote = "";
  let escaped = false;
  const flush = () => {
    if (!word) return;
    tokens.push({ type: "word", value: word });
    word = "";
  };
  const source = String(command || "");
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (escaped) {
      word += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      else word += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      flush();
      continue;
    }
    if ("<>".includes(character) || character === "&" && source[index + 1] === ">") {
      let descriptor = "";
      if (/^\d+$/.test(word)) {
        descriptor = word;
        word = "";
      } else {
        flush();
      }
      let operator = character;
      if (source[index + 1] === character || source[index + 1] === "&") {
        operator += source[++index];
      }
      tokens.push({ type: "redirect", value: `${descriptor}${operator}` });
      continue;
    }
    if (";&|()".includes(character)) {
      flush();
      let operator = character;
      if (source[index + 1] === character && ";&|".includes(character)) {
        operator += source[++index];
      }
      tokens.push({ type: "separator", value: operator });
      continue;
    }
    word += character;
  }
  if (escaped) word += "\\";
  flush();
  return tokens;
}

function safeDevicePath(path) {
  const target = resolve("/", String(path || ""));
  return ["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr"].includes(target)
    || /^\/dev\/fd\/\d+$/.test(target);
}

function shellAccesses(command) {
  const tokens = shellTokens(command);
  const accesses = [];
  let commandPosition = true;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type === "separator") {
      commandPosition = true;
      continue;
    }
    if (token.type === "redirect") {
      const target = tokens[index + 1];
      if (!target || target.type !== "word") continue;
      index++;
      const descriptorCopy = token.value.endsWith(">&") || token.value.endsWith("<&");
      if (!descriptorCopy && !token.value.includes("<<")) {
        accesses.push({ value: target.value, redirect: true });
      }
      continue;
    }
    if (commandPosition && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value)) continue;
    if (commandPosition) {
      commandPosition = false;
      if (!/^(?:\.{0,2}\/|~\/|\$HOME\/)/.test(token.value)) continue;
    }
    let value = token.value;
    if (value.startsWith("-") && value.includes("=")) value = value.slice(value.indexOf("=") + 1);
    if (
      value === "~" || value.startsWith("~/") || value.startsWith("$HOME/")
      || value.startsWith("/") || value === ".." || value.startsWith("../")
      || value.startsWith("./") || value.includes("/")
    ) accesses.push({ value, redirect: false });
  }
  return accesses;
}

export function hardSafetyViolation(toolName, args = {}, workspace = process.cwd()) {
  if (["write", "edit"].includes(toolName) && args.path && systemMutationPath(args.path, workspace)) {
    return "Modifying system directories is blocked.";
  }
  if (toolName !== "bash") return "";
  const command = String(args.command || "").trim();
  if (/(?:^|[;&|]\s*)(?:sudo|doas|pkexec|su)(?:\s|$)/i.test(command)) {
    return "Privilege escalation is blocked.";
  }
  const root = resolve(workspace);
  const destructiveRoot = /(?:^|[;&|]\s*)rm\s+(?=[^;&|]*(?:-[A-Za-z]*r[A-Za-z]*|--recursive))(?=[^;&|]*(?:-[A-Za-z]*f[A-Za-z]*|--force))([^;&|]*)/gi;
  for (const match of command.matchAll(destructiveRoot)) {
    const targets = match[1].trim().split(/\s+/).filter(token => !token.startsWith("-"));
    if (targets.some(target => {
      const resolved = resolve(args.workdir || workspace, expandHome(target));
      return resolved === "/" || resolved === root;
    })) return "Deleting the workspace root or filesystem root is blocked.";
  }
  if (
    /(?:^|[;&|]\s*)(?:rm|mv|cp|chmod|chown|mkdir|touch|install|tee)\b[^;&|]*\/(?:bin|boot|dev|etc|proc|sbin|sys|usr)(?:\/|\s|$)/i
      .test(command)
    || shellAccesses(command).some(access =>
      access.redirect
      && !safeDevicePath(access.value)
      && systemMutationPath(access.value, args.workdir || workspace)
    )
  ) return "Modifying system directories is blocked.";
  return "";
}

function shellPaths(command, workdir, workspace) {
  const cwd = resolve(workspace, expandHome(workdir || workspace));
  const paths = workdir ? [cwd] : [];
  for (const access of shellAccesses(command)) {
    const expanded = expandHome(access.value);
    const target = resolve(cwd, expanded);
    if (safeDevicePath(target)) continue;
    paths.push(target);
  }
  return [...new Set(paths.map(path => outside(path, workspace)).filter(Boolean))];
}

export function externalPaths(toolName, args = {}, workspace = process.cwd()) {
  if (toolName === "apply_patch") return [];
  if (toolName === "bash") return shellPaths(args.command, args.workdir, workspace);
  if (!args.path) return [];
  const path = outside(String(args.path), workspace);
  return path ? [path] : [];
}

export function externalPath(args = {}, workspace = process.cwd()) {
  return externalPaths("read", args, workspace)[0] || null;
}
