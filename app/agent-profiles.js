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
    tools: ["read", "glob", "grep", "bash", "websearch", "webfetch", "question", "think", "skill", "todowrite", "mcp_*"],
    instructions: `Remain read-only until the user directly approves implementation.
Inspect only relevant source, configuration, tests, and read-only Git state.
Never use a workspace-changing shell command or any mutation tool.
Ask one question only when its answer materially changes architecture, behavior, compatibility, UX, security, or scope.
Use the question tool with stable IDs, concise option descriptions, and exactly one recommended option when justified. Include a custom answer option only when useful. Never choose for the user.
Preserve the user's answers and use them in the final plan.
Before finishing, create a pending todowrite checklist and present an Implementation Plan containing Objective, Selected decisions, Files and code areas, Changes to apply, Risks, and Verification.
State that no files have been modified. Do not ask for implementation approval in prose; KhazAI presents the secure approval UI after the plan is complete.`,
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
