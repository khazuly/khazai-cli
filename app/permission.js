import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const DEFAULT_PERMISSIONS = {
  edit: "allow",
  write: "allow",
  read: "allow",
  bash: "ask",
  glob: "allow",
  grep: "allow",
  web: "ask",
  websearch: "allow",
  webfetch: "allow",
  analyze: "allow",
  repo: "allow",
  question: "allow",
  task: "ask",
};

export class PermissionService {
  constructor(workspace) {
    this.workspace = workspace;
    this.globalConfigPath = join(homedir(), ".config", "khazai-ai", "permissions.json");
    this.projectConfigPath = join(workspace, ".khazai", "permissions.json");
  }

  loadConfig() {
    let permissions = { ...DEFAULT_PERMISSIONS };

    if (existsSync(this.globalConfigPath)) {
      try {
        const global = JSON.parse(readFileSync(this.globalConfigPath, "utf-8"));
        permissions = { ...permissions, ...global };
      } catch {}
    }

    if (existsSync(this.projectConfigPath)) {
      try {
        const project = JSON.parse(readFileSync(this.projectConfigPath, "utf-8"));
        permissions = { ...permissions, ...project };
      } catch {}
    }

    return permissions;
  }

  getPermission(toolName) {
    const permissions = this.loadConfig();
    return permissions[toolName] || "ask";
  }

  isAllowed(toolName) {
    const permission = this.getPermission(toolName);
    return permission === "allow";
  }

  isAsk(toolName) {
    const permission = this.getPermission(toolName);
    return permission === "ask";
  }

  isDenied(toolName) {
    const permission = this.getPermission(toolName);
    return permission === "deny";
  }

  createGlobalConfig() {
    const dir = dirname(this.globalConfigPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.globalConfigPath, JSON.stringify(DEFAULT_PERMISSIONS, null, 2), "utf-8");
  }

  createProjectConfig() {
    const dir = dirname(this.projectConfigPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.projectConfigPath, JSON.stringify(DEFAULT_PERMISSIONS, null, 2), "utf-8");
  }
}
