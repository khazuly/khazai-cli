import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

const BUILT_INS = {
  build: {
    name: "build",
    role: "primary",
    description: "Default coding agent with the complete configured tool set.",
    tools: ["*"],
    instructions: "",
  },
  plan: {
    name: "plan",
    role: "primary",
    description: "Read-only planning and investigation agent.",
    tools: ["read", "glob", "grep", "bash", "websearch", "webfetch", "question", "task", "skill", "todowrite", "mcp_*"],
    instructions: "Inspect and plan only. Do not modify workspace files.",
  },
  explore: {
    name: "explore",
    role: "subagent",
    description: "Fast read-only workspace exploration agent.",
    tools: ["read", "glob", "grep"],
    instructions: "Return concise evidence from read-only inspection.",
  },
};

function scalar(value) {
  const source = String(value || "").trim();
  if (source.startsWith("[") && source.endsWith("]")) {
    return source.slice(1, -1).split(",").map(item => item.trim()).filter(Boolean);
  }
  if (source === "true") return true;
  if (source === "false") return false;
  const number = Number(source);
  return source && Number.isFinite(number) ? number : source;
}

function parseProfile(path) {
  const source = readFileSync(path, "utf-8");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/m.exec(source);
  if (!match) return null;
  let metadata;
  try {
    metadata = YAML.parse(match[1]) || {};
  } catch {
    metadata = {};
    for (const line of match[1].split("\n")) {
      const entry = /^([a-zA-Z][\w-]*):\s*(.*)$/.exec(line);
      if (entry) metadata[entry[1]] = scalar(entry[2]);
    }
  }
  const name = String(metadata.name || "").trim();
  if (!name) return null;
  return {
    name,
    role: metadata.role === "subagent" ? "subagent" : "primary",
    description: String(metadata.description || ""),
    model: metadata.model ? String(metadata.model) : undefined,
    tools: Array.isArray(metadata.tools) ? metadata.tools : ["*"],
    permission: metadata.permission && typeof metadata.permission === "object"
      ? metadata.permission
      : {},
    instructions: match[2].trim(),
  };
}

function loadDirectory(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .filter(name => name.endsWith(".md"))
    .map(name => {
      try { return parseProfile(join(path, name)); } catch { return null; }
    })
    .filter(Boolean);
}

export function loadAgentProfiles(workspace) {
  const profiles = new Map(Object.entries(BUILT_INS));
  for (const profile of [
    ...loadDirectory(join(homedir(), ".config", "khazai-ai", "agents")),
    ...loadDirectory(join(workspace, ".khazai", "agents")),
  ]) profiles.set(profile.name, profile);
  return profiles;
}

export function getAgentProfile(workspace, name = "build") {
  const profiles = loadAgentProfiles(workspace);
  return profiles.get(name) || profiles.get("build");
}
