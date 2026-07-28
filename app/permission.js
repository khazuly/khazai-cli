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

export class PermissionService {
  constructor(workspace, config = loadConfig(workspace), options = {}) {
    this.workspace = resolve(workspace);
    this.config = config || {};
    this.agentPermission = options.agentPermission || {};
    this.auto = Boolean(options.auto);
    this.sessionRules = [];
    this.approvals = [];
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
    const safety = hardSafetyViolation(toolName, args, this.workspace);
    if (safety) {
      return {
        decision: "deny",
        permission,
        pattern: "*",
        patterns: values,
        always: [],
        value: values[0] || "*",
        source: "safety",
        reason: safety,
      };
    }
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
    const safety = hardSafetyViolation(toolName, args, this.workspace);
    if (safety) {
      return {
        decision: "deny",
        permission: "external_directory",
        pattern: "*",
        patterns: paths,
        always: [],
        value: paths[0],
        source: "safety",
        reason: safety,
      };
    }
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

  recordApproval(approval) {
    this.approvals.push({
      permission: String(approval.permission || permissionName(approval.tool) || "unknown"),
      tool: String(approval.tool || "unknown"),
      value: String(approval.value || "*"),
      source: String(approval.source || "user"),
      createdAt: new Date().toISOString(),
    });
    this.approvals = this.approvals.slice(-200);
  }

  approvalHistory() {
    return this.approvals.map(approval => ({ ...approval }));
  }

  restoreApprovals(approvals) {
    this.approvals = Array.isArray(approvals)
      ? approvals.slice(-200).map(approval => ({ ...approval }))
      : [];
  }

  clearSession() {
    this.sessionRules = [];
    this.approvals = [];
  }

  setAuto(value) {
    this.auto = Boolean(value);
  }
}
