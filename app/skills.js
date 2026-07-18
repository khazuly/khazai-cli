import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";

const MAX_SKILL_BYTES = 256 * 1024;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function gitRoot(workspace) {
  let cursor = resolve(workspace);
  while (true) {
    if (existsSync(join(cursor, ".git"))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return resolve(workspace);
    cursor = parent;
  }
}

function projectDirectories(workspace) {
  const current = resolve(workspace);
  const root = gitRoot(current);
  const path = [];
  let cursor = current;
  while (cursor === root || cursor.startsWith(`${root}${sep}`)) {
    path.push(cursor);
    if (cursor === root) break;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return path.reverse();
}

function sourceRoots(workspace, home) {
  const roots = [
    { path: join(home, ".agents", "skills"), scope: "global", namespace: "agents" },
    { path: join(home, ".claude", "skills"), scope: "global", namespace: "claude" },
    { path: join(home, ".config", "opencode", "skills"), scope: "global", namespace: "opencode" },
    { path: join(home, ".config", "khazai-ai", "skills"), scope: "global", namespace: "khazai" },
  ];
  for (const directory of projectDirectories(workspace)) {
    roots.push(
      { path: join(directory, ".agents", "skills"), scope: "project", namespace: "agents" },
      { path: join(directory, ".claude", "skills"), scope: "project", namespace: "claude" },
      { path: join(directory, ".opencode", "skills"), scope: "project", namespace: "opencode" },
      { path: join(directory, ".khazai", "skills"), scope: "project", namespace: "khazai" },
    );
  }
  return roots;
}

function parseSkill(path, source) {
  if (Buffer.byteLength(source) > MAX_SKILL_BYTES) return null;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match) return null;
  const document = parseDocument(match[1], { prettyErrors: false, strict: true });
  if (document.errors.length) return null;
  const metadata = document.toJS();
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  if (typeof metadata.name !== "string" || typeof metadata.description !== "string") return null;
  if (metadata.license !== undefined && typeof metadata.license !== "string") return null;
  if (metadata.compatibility !== undefined && typeof metadata.compatibility !== "string") return null;
  if (metadata.metadata !== undefined && (
    !metadata.metadata
    || typeof metadata.metadata !== "object"
    || Array.isArray(metadata.metadata)
    || Object.values(metadata.metadata).some(value => typeof value !== "string")
  )) return null;
  const name = metadata.name.trim();
  const description = metadata.description.trim();
  if (!SKILL_NAME.test(name) || name.length > 64 || name !== basename(dirname(path))) return null;
  if (!description || description.length > 1024) return null;
  const extra = metadata.metadata || {};
  return {
    name,
    description,
    license: metadata.license ? String(metadata.license) : "",
    compatibility: metadata.compatibility ? String(metadata.compatibility) : "",
    metadata: extra,
    content: source,
  };
}

function loadRoot(root) {
  if (!existsSync(root.path)) return [];
  let realRoot;
  try {
    if (lstatSync(root.path).isSymbolicLink()) return [];
    realRoot = realpathSync(root.path);
  } catch { return []; }
  return readdirSync(root.path, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
    .map(entry => {
      const directory = join(root.path, entry.name);
      const path = join(directory, "SKILL.md");
      try {
        const fileInfo = lstatSync(path);
        if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || statSync(path).size > MAX_SKILL_BYTES) return null;
        const realPath = realpathSync(path);
        if (relative(realRoot, realPath).startsWith(`..${sep}`) || relative(realRoot, realPath) === "..") return null;
        const parsed = parseSkill(path, readFileSync(path, "utf-8"));
        return parsed ? {
          ...parsed,
          path,
          root: directory,
          scope: root.scope,
          namespace: root.namespace,
        } : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export class SkillService {
  constructor(workspace, { home = homedir() } = {}) {
    this.workspace = resolve(workspace);
    this.home = resolve(home);
    this.roots = sourceRoots(this.workspace, this.home);
  }

  list() {
    const skills = new Map();
    for (const root of this.roots) {
      for (const skill of loadRoot(root)) skills.set(skill.name, skill);
    }
    return [...skills.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  revision() {
    const entries = [];
    for (const root of this.roots) {
      try {
        const rootInfo = statSync(root.path);
        entries.push(`${root.path}:${rootInfo.mtimeMs}`);
        for (const entry of readdirSync(root.path, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
          const path = join(root.path, entry.name, "SKILL.md");
          try {
            const info = statSync(path);
            entries.push(`${path}:${info.size}:${info.mtimeMs}`);
          } catch {}
        }
      } catch {}
    }
    return entries.join("|");
  }

  load(name) {
    return this.list().find(skill => skill.name === String(name || "")) || null;
  }
}

export function listSkills(workspace) {
  return new SkillService(workspace).list();
}

export { MAX_SKILL_BYTES };
