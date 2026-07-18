import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadConfig } from "../config/index.js";

const DEFAULT_PERMISSIONS = {
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

function readJSON(path) {
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
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

function permissionName(toolName) {
  return ["write", "edit", "apply_patch"].includes(toolName) ? "edit" : toolName;
}

function shellSegments(command) {
  return String(command || "")
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map(value => value.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

function actionValues(toolName, args = {}) {
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

function rulesFromLayer(layer) {
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

function resolveAction(rules, permission, value) {
  let matched = null;
  for (const rule of rules) {
    if (matchesPermission(rule, permission) && wildcard(rule.pattern, value)) matched = rule;
  }
  return matched;
}

function outside(path, workspace) {
  const target = resolve(workspace, expandHome(path));
  const rel = relative(resolve(workspace), target);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? target : null;
}

function shellPaths(command, workdir, workspace) {
  const paths = [];
  if (workdir) paths.push(workdir);
  const tokens = String(command || "").match(/(?:[^\s"'`]+|"[^"]*"|'[^']*')+/g) || [];
  for (const raw of tokens) {
    let token = raw.replace(/^['"]|['"]$/g, "").replace(/^\d*[<>]+/, "");
    if (token.includes("=")) token = token.slice(token.indexOf("=") + 1);
    if (
      token === "~" || token.startsWith("~/") || token.startsWith("$HOME/")
      || token.startsWith("/") || token === ".." || token.startsWith("../")
    ) paths.push(token);
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

export class PermissionService {
  constructor(workspace, config = loadConfig(workspace), options = {}) {
    this.workspace = resolve(workspace);
    this.config = config || {};
    this.agentPermission = options.agentPermission || {};
    this.auto = Boolean(options.auto);
    this.sessionRules = [];
    this.globalConfigPath = join(homedir(), ".config", "khazai-ai", "permissions.json");
    this.projectConfigPath = join(this.workspace, ".khazai", "permissions.json");
  }

  rules() {
    return [
      ...rulesFromLayer(DEFAULT_PERMISSIONS),
      ...(Array.isArray(this.config._permissionLayers) && this.config._permissionLayers.length
        ? this.config._permissionLayers.flatMap(rulesFromLayer)
        : rulesFromLayer(this.config.permission)),
      ...rulesFromLayer(readJSON(this.globalConfigPath)),
      ...rulesFromLayer(readJSON(this.projectConfigPath)),
      ...rulesFromLayer(this.agentPermission),
      ...this.sessionRules,
    ];
  }

  evaluate(toolName, args = {}) {
    const permission = permissionName(toolName);
    const values = actionValues(toolName, args);
    let selected = null;
    for (const value of values) {
      const match = resolveAction(this.rules(), permission, value);
      if (!match) continue;
      if (!selected || match.action === "deny" || (match.action === "ask" && selected.action === "allow")) {
        selected = { ...match, value };
      }
    }
    selected ||= { permission, pattern: "*", action: "allow", value: values[0] || "*" };
    const decision = this.auto && selected.action === "ask" ? "allow" : selected.action;
    const patterns = values.map(value => {
      if (toolName !== "bash") return value || "*";
      const prefix = value.trim().split(/\s+/).slice(0, 2).join(" ");
      return prefix ? `${prefix}*` : "*";
    });
    return {
      decision,
      permission,
      pattern: selected.pattern,
      patterns,
      always: patterns,
      value: selected.value,
      source: this.auto && selected.action === "ask" ? "auto" : "config",
      reason: decision === "ask"
        ? `Approval required for ${permission}: ${selected.value}`
        : "",
    };
  }

  evaluateExternalDirectory(toolNameOrArgs, maybeArgs = {}) {
    const toolName = typeof toolNameOrArgs === "string" ? toolNameOrArgs : "read";
    const args = typeof toolNameOrArgs === "string" ? maybeArgs : toolNameOrArgs;
    const paths = externalPaths(toolName, args, this.workspace);
    if (!paths.length) return null;
    let selected = null;
    for (const path of paths) {
      const match = resolveAction(this.rules(), "external_directory", path)
        || { permission: "external_directory", pattern: "*", action: "ask" };
      if (!selected || match.action === "deny" || (match.action === "ask" && selected.action === "allow")) {
        selected = { ...match, value: path };
      }
    }
    const decision = this.auto && selected.action === "ask" ? "allow" : selected.action;
    return {
      decision,
      permission: "external_directory",
      pattern: selected.pattern,
      patterns: paths,
      always: paths.map(path => path.endsWith(sep) ? `${path}**` : path),
      value: selected.value,
      source: this.auto && selected.action === "ask" ? "auto" : "config",
      reason: decision === "ask"
        ? `Approval required to access a path outside the workspace: ${selected.value}`
        : "",
    };
  }

  allowForSession(toolName, patterns) {
    const permission = permissionName(toolName);
    const values = Array.isArray(patterns) ? patterns : [patterns || "*"];
    for (const pattern of values) {
      this.sessionRules.push({ permission, pattern: String(pattern), action: "allow" });
    }
  }

  clearSession() {
    this.sessionRules = [];
  }

  setAuto(value) {
    this.auto = Boolean(value);
  }
}
