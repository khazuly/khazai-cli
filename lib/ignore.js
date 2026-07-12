import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_IGNORE = [
  "*/node_modules/*", "*/.git/*", "*/__pycache__/*", "*/dist/*",
  "*/build/*", "*/.next/*", "*/.nuxt/*", "*/.cache/*", "*/venv/*",
  "*/.venv/*", "*/env/*", "*/.gradle/*", "*/target/*", "*/.eggs/*",
  "*/vendor/*", "*/.terraform/*", "*/Pods/*", "*.pyc", ".DS_Store",
  "*/.gitkeep", "*/.gitattributes", "*/.gitmodules",
  "*/.khazai-ai/*", "*/.opencode/*", "*/.claude/*",
];

function parseGitignore(cwd) {
  const path = resolve(cwd, ".gitignore");
  if (!existsSync(path)) return [];

  const patterns = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#") || raw.startsWith("!")) continue;

    let p = raw;
    if (p.startsWith("/")) p = p.slice(1);
    if (p.endsWith("/")) p += "*";
    if (!p.includes("/")) p = "*/" + p;
    if (!p.startsWith("*")) p = "*/" + p;

    patterns.push(p);
  }

  return patterns;
}

export function getIgnorePatterns(cwd) {
  const gitignore = parseGitignore(cwd);
  return [...new Set([...gitignore, ...DEFAULT_IGNORE])];
}

export function getUnusualFiles(cwd) {
  const unusual = [];
  for (const dir of ["node_modules", ".git", "dist", "build"]) {
    const p = resolve(cwd, dir);
    if (existsSync(p)) {
      unusual.push(`${dir} (present, excluded by default)`);
    }
  }
  return unusual;
}

export function buildFindExclusions(cwd, extra = []) {
  const patterns = [...getIgnorePatterns(cwd), ...extra];
  return patterns.map(p => `-not -path "${p}"`).join(" ");
}
