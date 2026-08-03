import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { loadConfig } from "../config/index.js";
import {
  DEFAULT_PERMISSIONS,
  PERMISSION_STORE_DIR,
  PERMISSION_STORE_VERSION,
  actionValues,
  atomicWriteStore,
  canonicalPath,
  externalPaths,
  hardSafetyViolation,
  isDirectoryPath,
  outside,
  permissionName,
  readJSON,
  resolveAction,
  rulesFromLayer,
  shellPermissionEvidence,
  workspaceStoreKey,
} from "./permission-policy.js";
export { externalPath, externalPaths, hardSafetyViolation, shellPermissionEvidence } from "./permission-policy.js";

export class PermissionRejectedError extends Error {
  constructor(permission, pattern) {
    super(`Permission rejected: ${permission} (${pattern})`);
    this.name = "PermissionRejectedError";
    this.permission = permission;
    this.pattern = pattern;
  }
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
    this.storePath = options.storePath || join(PERMISSION_STORE_DIR, `${workspaceStoreKey(this.workspace)}.json`);
    this._store = this._loadStore();
    this._writeQueue = Promise.resolve();
  }

  _loadStore() {
    const empty = {
      version: PERMISSION_STORE_VERSION,
      workspaceRoot: this.workspace,
      allowAll: false,
      revision: 0,
      rules: [],
    };
    let raw;
    try {
      raw = readFileSync(this.storePath, "utf-8");
    } catch {
      return empty;
    }
    try {
      const data = JSON.parse(raw);
      if (!data || typeof data !== "object" || Array.isArray(data)) return empty;
      if (data.workspaceRoot && resolve(data.workspaceRoot) !== this.workspace) return empty;
      const rules = (Array.isArray(data.rules) ? data.rules : [])
        .filter(rule => rule && typeof rule === "object"
          && typeof rule.action === "string"
          && typeof rule.path === "string"
          && (rule.scope === "exact" || rule.scope === "directory"))
        .map(rule => ({
          id: String(rule.id || randomUUID().slice(0, 8)),
          action: rule.action,
          path: String(rule.path),
          scope: rule.scope,
          createdAt: String(rule.createdAt || new Date().toISOString()),
        }));
      return {
        version: PERMISSION_STORE_VERSION,
        workspaceRoot: this.workspace,
        allowAll: data.allowAll === true,
        revision: Number(data.revision) || 0,
        rules,
      };
    } catch {
      return empty;
    }
  }

  _writeStore(state) {
    atomicWriteStore(this.storePath, state);
  }

  _mutate(transform) {
    const task = this._writeQueue.then(() => {
      const latest = this._loadStore();
      const next = transform(latest);
      this._writeStore(next);
      this._store = next;
      return next;
    });
    this._writeQueue = task.catch(() => {});
    return task;
  }

  allowAlways(action, value) {
    const path = canonicalPath(value, this.workspace);
    const scope = isDirectoryPath(path) ? "directory" : "exact";
    return this._mutate(state => {
      if (state.rules.some(rule => rule.action === action && rule.path === path)) return state;
      const rule = {
        id: randomUUID().slice(0, 8),
        action,
        path,
        scope,
        createdAt: new Date().toISOString(),
      };
      return { ...state, revision: state.revision + 1, rules: [...state.rules, rule] };
    });
  }

  setAllowAll(value) {
    return this._mutate(state => ({ ...state, revision: state.revision + 1, allowAll: Boolean(value) }));
  }

  revokeRule(id) {
    return this._mutate(state => {
      const rules = state.rules.filter(rule => rule.id !== id);
      if (rules.length === state.rules.length) return state;
      return { ...state, revision: state.revision + 1, rules };
    });
  }

  resetPermissions() {
    return this._mutate(state => ({
      ...state,
      revision: state.revision + 1,
      allowAll: false,
      rules: [],
    }));
  }

  permissionState() {
    return {
      allowAll: this._store.allowAll,
      rules: this._store.rules.map(rule => ({ ...rule })),
    };
  }

  setAgentPermission(permission = {}) {
    this.agentPermission = permission;
  }

  _matchRule(action, value) {
    const canonical = canonicalPath(value, this.workspace);
    for (const rule of this._store.rules) {
      if (rule.action !== action) continue;
      if (rule.scope === "directory") {
        if (canonical === rule.path || canonical.startsWith(`${rule.path}${sep}`)) return rule;
      } else if (canonical === rule.path) {
        return rule;
      }
    }
    return null;
  }

  _persistentAllowsPath(action, toolName, args) {
    let targets;
    if (toolName === "apply_patch") {
      targets = [...String(args.patchText || "").matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)]
        .map(match => match[1]);
      if (!targets.length) return false;
    } else if (args.path) {
      targets = [args.path];
    } else {
      return false;
    }
    return targets.every(target => Boolean(this._matchRule(action, target)));
  }

  _allowAllCovers(toolName, args) {
    if (toolName === "webfetch" || toolName === "websearch") return false;
    if (toolName === "bash") {
      const evidence = shellPermissionEvidence(args, this.workspace);
      if (/^Unclassified command:|could not be parsed/i.test(evidence.reason)) return false;
    }
    return externalPaths(toolName, args, this.workspace).length === 0;
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
    let decision = selected.action;
    let source = "config";
    if (decision === "ask" && this._store.allowAll && this._allowAllCovers(toolName, args)) {
      decision = "allow";
      source = "allow-all";
    } else if (decision === "ask" && this._persistentAllowsPath(permission, toolName, args)) {
      decision = "allow";
      source = "persisted";
    } else if (decision === "ask" && this.auto) {
      decision = "allow";
      source = "auto";
    }
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
      source,
      reason: decision === "ask"
        ? `Approval required for ${permission}: ${selected.value}`
        : "",
      evidence: toolName === "bash" ? shellPermissionEvidence(args, this.workspace) : null,
    };
  }

  evaluateExternalDirectory(toolNameOrArgs, maybeArgs = {}) {
    const toolName = typeof toolNameOrArgs === "string" ? toolNameOrArgs : "read";
    const args = typeof toolNameOrArgs === "string" ? maybeArgs : toolNameOrArgs;
    const evidence = toolName === "bash" ? shellPermissionEvidence(args, this.workspace) : null;
    const paths = evidence ? evidence.externalTargets : externalPaths(toolName, args, this.workspace);
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
    let persisted = false;
    for (const path of paths) {
      const rule = this._matchRule("external_directory", path);
      if (rule) persisted = true;
      const match = rule
        ? { permission: "external_directory", pattern: path, action: "allow" }
        : resolveAction(this.rules(), "external_directory", path)
          || { permission: "external_directory", pattern: "*", action: "ask" };
      if (!selected || match.action === "deny" || (match.action === "ask" && selected.action === "allow")) {
        selected = { ...match, value: path };
      }
    }
    const autoAllowed = this.auto && selected.action === "ask";
    return {
      decision: autoAllowed ? "allow" : selected.action,
      permission: "external_directory",
      pattern: selected.pattern,
      patterns: paths,
      always: paths.map(path => path.endsWith(sep) ? `${path}**` : path),
      value: selected.value,
      source: persisted ? "persisted" : (autoAllowed ? "auto" : "config"),
      reason: selected.action === "ask" && !autoAllowed
        ? `Approval required to access a path outside the workspace: ${selected.value}`
        : "",
      evidence,
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
