import { readFileSync, existsSync, renameSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { realpathSync, statSync } from "node:fs";
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, resolve, dirname, basename } from "node:path";
import { homedir } from "node:os";

const EXCLUDE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "target",
  "__pycache__", ".venv", "venv", "env", ".env", ".khazai-ai",
]);
const EXCLUDE_FILES = new Set([
  ".env", ".git-credentials", "package-lock.json", "yarn.lock",
  "pnpm-lock.yaml", "Gemfile.lock", "poetry.lock",
]);

function isExcluded(name, absPath) {
  if (EXCLUDE_DIRS.has(name)) return true;
  if (EXCLUDE_FILES.has(name)) return true;
  try {
    const st = statSync(absPath);
    if (!st.isFile()) return true;
    if (st.size > 100_000) return true;
  } catch { return true; }
  return false;
}

function tryRead(path) {
  try { return readFileSync(path, "utf-8"); } catch { return null; }
}

function detectWorkspaceRoot(start) {
  const resolved = resolve(start || process.cwd());
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: resolved,
    encoding: "utf-8",
    timeout: 3000,
    windowsHide: true,
  });
  if (result.status === 0 && result.stdout) {
    try {
      return realpathSync(result.stdout.trim());
    } catch {
      return result.stdout.trim();
    }
  }
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function resolveEntryPoints(root) {
  const entries = [];
  const candidates = [
    { path: join(root, "index.js"), label: "index.js" },
    { path: join(root, "index.mjs"), label: "index.mjs" },
    { path: join(root, "main.js"), label: "main.js" },
    { path: join(root, "cli.js"), label: "cli.js" },
    { path: join(root, "app.js"), label: "app.js" },
  ];
  for (const { path, label } of candidates) {
    if (existsSync(path)) entries.push(label);
  }
  const binDir = join(root, "bin");
  if (existsSync(binDir)) {
    try {
      for (const f of readdirSync(binDir)) {
        if (f.endsWith(".js") || f.endsWith(".mjs")) entries.push(`bin/${f}`);
      }
    } catch {}
  }
  return entries;
}

function resolveSourceDirs(root) {
  const dirs = [];
  const candidates = ["app", "lib", "src", "source", "tools", "ui", "config", "bin", "test", "tests", "scripts", "docs"];
  for (const name of candidates) {
    const abs = join(root, name);
    if (existsSync(abs) && statSync(abs).isDirectory()) dirs.push(name);
  }
  return dirs;
}

function resolveConfigFiles(root) {
  const files = [];
  const candidates = [
    "package.json", "tsconfig.json", "tsconfig.app.json",
    ".eslintrc", ".eslintrc.json", ".eslintrc.js", ".eslintrc.yaml",
    ".prettierrc", ".prettierrc.json", ".prettierrc.yaml",
    ".editorconfig", "jest.config.js", "jest.config.json",
    "vitest.config.js", "vitest.config.ts", ".mocharc.json",
    ".github/workflows/ci.yml", ".github/workflows/test.yml",
    "Makefile", "Dockerfile", "docker-compose.yml",
    ".gitignore", ".npmrc", ".nvmrc", ".node-version",
  ];
  for (const name of candidates) {
    const abs = join(root, name);
    if (existsSync(abs)) files.push(name);
  }
  return files;
}

function resolveScripts(root) {
  const scripts = [];
  const scriptsDir = join(root, "scripts");
  if (existsSync(scriptsDir)) {
    try {
      for (const f of readdirSync(scriptsDir)) {
        if (f.endsWith(".js") || f.endsWith(".mjs") || f.endsWith(".sh")) {
          scripts.push(`scripts/${f}`);
        }
      }
    } catch {}
  }
  return scripts;
}

function inspectPackage(root) {
  const pkgPath = join(root, "package.json");
  const raw = tryRead(pkgPath);
  if (!raw) return {};
  try {
    const pkg = JSON.parse(raw);
    return {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      type: pkg.type,
      scripts: pkg.scripts,
      dependencies: pkg.dependencies ? Object.keys(pkg.dependencies) : [],
      devDependencies: pkg.devDependencies ? Object.keys(pkg.devDependencies) : [],
      engines: pkg.engines,
      bin: pkg.bin,
    };
  } catch {
    return {};
  }
}

function inspectGitStatus(root) {
  const result = spawnSync("git", ["status", "--short"], {
    cwd: root,
    encoding: "utf-8",
    timeout: 3000,
    windowsHide: true,
  });
  if (result.status !== 0) return { branch: null, modified: 0, untracked: 0 };
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  let modified = 0;
  let untracked = 0;
  for (const line of lines) {
    if (line.startsWith("??")) untracked++;
    else if (line.trim()) modified++;
  }
  const branchResult = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: root,
    encoding: "utf-8",
    timeout: 3000,
    windowsHide: true,
  });
  const branch = branchResult.status === 0 ? branchResult.stdout.trim() : null;
  return { branch, modified, untracked };
}

export function writeAtomicFile(content, dest) {
  const target = resolve(dest);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  mkdirSync(dirname(target), { recursive: true });
  try {
    writeFileSync(tmp, content, "utf-8");
    renameSync(tmp, target);
  } catch (error) {
    try { unlinkSync(tmp); } catch {}
    throw error;
  }
}

export class InitGenerator {
  constructor(workspaceRoot) {
    this.workspaceRoot = workspaceRoot;
    this.inspectedFiles = [];
  }

  detectWorkspace() {
    return detectWorkspaceRoot(this.workspaceRoot);
  }

  inspect() {
    const root = this.workspaceRoot;
    if (!root) throw new Error("Workspace root not resolved");

    const pkg = inspectPackage(root);
    const dirs = resolveSourceDirs(root);
    const entries = resolveEntryPoints(root);
    const configs = resolveConfigFiles(root);
    const scripts = resolveScripts(root);
    const gitStatus = inspectGitStatus(root);

    const inspected = [];

    if (existsSync(join(root, "package.json"))) inspected.push("package.json");
    if (existsSync(join(root, "AGENTS.md"))) inspected.push("AGENTS.md");
    if (existsSync(join(root, "README.md"))) inspected.push("README.md");

    const configRead = [];
    for (const name of configs) {
      if (name === "package.json") continue;
      configRead.push(name);
    }

    for (const name of configRead.slice(0, 5)) {
      inspected.push(name);
    }

    for (const dir of dirs.slice(0, 8)) {
      try {
        const entries = readdirSync(join(root, dir));
        const sample = entries.filter(e => !isExcluded(e, join(root, dir, e))).slice(0, 4);
        for (const e of sample) inspected.push(`${dir}/${e}`);
      } catch {}
    }

    this.inspected = [...new Set(inspected)];
    this.pkg = pkg;
    this.dirs = dirs;
    this.entries = entries;
    this.configs = configs;
    this.scripts = scripts;
    this.gitStatus = gitStatus;

    return {
      inspectedFiles: this.inspected,
      package: pkg,
      directories: dirs,
      entryPoints: entries,
      configFiles: configs,
      scripts,
      gitStatus,
    };
  }

  generate() {
    const root = this.workspaceRoot;
    const pkg = this.pkg || {};
    const dirs = this.dirs || [];
    const entries = this.entries || [];
    const scripts = this.scripts || [];
    const gitStatus = this.gitStatus || {};
    const configs = this.configs || [];

    const hasReact = (pkg.dependencies || []).some(d => d === "react" || d.startsWith("react-") || d === "ink");
    const hasInk = (pkg.dependencies || []).some(d => d === "ink");
    const hasTypeScript = (pkg.devDependencies || []).some(d => d.startsWith("typescript"));
    const hasESLint = configs.some(c => c.startsWith(".eslintrc") || c === "eslint.config.js" || c === "eslint.config.mjs");
    const hasPrettier = configs.some(c => c.startsWith(".prettierrc"));
    const hasTests = dirs.includes("test") || dirs.includes("tests");
    const hasCI = configs.some(c => c.startsWith(".github"));
    const isESM = pkg.type === "module";

    const cmdInstall = pkg.scripts?.install || "npm install";
    const cmdDev = pkg.scripts?.dev || pkg.scripts?.start || null;
    const cmdBuild = pkg.scripts?.build || null;
    const cmdLint = pkg.scripts?.lint || (hasESLint ? "eslint ." : null);
    const cmdTypecheck = pkg.scripts?.typecheck || (hasTypeScript ? "tsc --noEmit" : null);
    const cmdTest = pkg.scripts?.test || null;
    const engineNote = pkg.engines?.node ? `Node.js >= ${String(pkg.engines.node).replace(/^>=?\s*/, "")}` : "Node.js >= 18";

    const sections = [];

    // Project Overview
    sections.push(`# Project Overview\n`);
    sections.push(`- **Purpose**: ${pkg.description || "Software engineering agent CLI"}`);
    sections.push(`- **Primary language**: JavaScript (ESM${isESM ? "" : ", CommonJS"})`);
    sections.push(`- **Runtime**: ${engineNote}`);
    if (hasReact) sections.push(`- **UI framework**: ${hasInk ? "Ink (React for terminal)" : "React"}`);
    sections.push(`- **Package manager**: npm`);
    if (entries.length) sections.push(`- **Entry points**: ${entries.join(", ")}`);
    sections.push("");

    // Repository Structure
    sections.push(`# Repository Structure\n`);
    if (dirs.length) {
      sections.push(`- **Source directories**: ${dirs.join(", ")}`);
    }
    if (entries.length) {
      sections.push(`- **Entry points**:`);
      for (const e of entries) sections.push(`  - \`${e}\``);
    }
    if (hasTests) sections.push(`- **Tests**: \`test/\` directory`);
    sections.push(`- **Configuration**: ${configs.length > 0 ? configs.join(", ") : "Standard project configuration"}`);
    if (scripts.length) {
      sections.push(`- **Scripts**:`);
      for (const s of scripts) sections.push(`  - \`${s}\``);
    }
    sections.push("");

    // Development Commands
    sections.push("# Development Commands\n");
    sections.push("```\nnpm install          # Install dependencies\n");
    if (cmdDev) sections.push("npm run dev           # Start development\n");
    if (cmdBuild) sections.push("npm run build         # Build the project\n");
    if (cmdLint) sections.push("npm run lint          # Run linter\n");
    if (cmdTypecheck) sections.push("npm run typecheck    # Run type checker\n");
    if (cmdTest) sections.push("npm test              # Run all tests\n");
    if (pkg.scripts?.check) sections.push("npm run check        # Check syntax\n");
    sections.push("```\n");

    // Code Standards
    sections.push(`# Code Standards\n`);
    sections.push(`- **Naming**: camelCase for functions and variables, PascalCase for classes and components`);
    sections.push(`- **Module style**: ES module (\`import\`/\`export\`)${isESM ? " (default)" : ""}`);
    if (hasPrettier) sections.push("- **Formatting**: Prettier");
    if (hasESLint) sections.push("- **Linting**: ESLint");
    sections.push(`- **Architecture**: Modular, single-responsibility files`);
    sections.push(`- **Async**: \`async/await\` with proper error handling; no unhandled rejections`);
    if (hasInk) sections.push("- **UI**: Ink terminal components; use `createElement as h` pattern");
    sections.push(`- **Error handling**: Structured error responses, no silent failures`);
    sections.push("");

    // Editing Rules
    sections.push(`# Editing Rules\n`);
    sections.push(`- Preserve existing behavior and public APIs`);
    sections.push(`- Inspect relevant files before making changes`);
    sections.push(`- Make targeted edits instead of full-file rewrites`);
    sections.push(`- Avoid unrelated refactors or scope creep`);
    sections.push(`- Do not create unnecessary files`);
    sections.push(`- Never introduce placeholder implementations`);
    sections.push(`- Do not remove existing functionality`);
    sections.push(`- Never expose secrets, API keys, or credentials`);
    sections.push("");

    // Testing and Verification
    sections.push("# Testing and Verification\n");
    sections.push("- After modifications verify with:\n");
    sections.push("  - `node --check` for syntax errors\n");
    if (cmdLint) sections.push("  - `" + cmdLint + "` for lint issues\n");
    if (cmdTypecheck) sections.push("  - `" + cmdTypecheck + "` for type errors\n");
    if (cmdTest) sections.push("  - `" + cmdTest + "` for test failures\n");
    sections.push("  - Targeted tests for changed modules\n");
    sections.push("- Report truthful test output: assertion failures, timeouts, non-zero exits\n");
    sections.push("- Review the final diff before completing work\n");
    sections.push("");

    // Project-Specific Notes
    sections.push(`# Project-Specific Notes\n`);
    if (hasInk) sections.push(`- **Ink UI constraints**: Components use \`h()\` (createElement), not JSX`);
    if (this.inspected && this.inspected.length > 0) {
      sections.push(`- **Source structure**: Based on ${this.inspected.length} inspected files`);
    }
    if (gitStatus.branch) {
      sections.push(`- **Git branch**: \`${gitStatus.branch}\` (${gitStatus.modified} modified, ${gitStatus.untracked} untracked)`);
    }
    if (hasCI) sections.push("- **CI**: GitHub Actions workflows present");
    sections.push("- All source code and UI text must be in English");
    sections.push("- No emoji or decorative characters in rendered UI");
    sections.push("");

    const content = sections.join("\n");
    return content.trim() + "\n";
  }

  validate(content) {
    if (!content || content.trim().length < 20) {
      return { valid: false, error: "Generated content is too short" };
    }
    if (!content.startsWith("#")) {
      return { valid: false, error: "Content must start with a Markdown heading" };
    }
    const secretPatterns = [
      /sk-[a-zA-Z0-9]{20,}/,
      /ghp_[a-zA-Z0-9]{36}/,
      /gho_[a-zA-Z0-9]{36}/,
      /xox[bpras]-\d+-[a-f0-9]{8,}/,
      /AKIA[0-9A-Z]{16}/,
      /-----BEGIN (RSA |EC )?PRIVATE KEY/,
    ];
    for (const pattern of secretPatterns) {
      if (pattern.test(content)) {
        return { valid: false, error: "Generated content may contain secrets" };
      }
    }
    return { valid: true };
  }

  writeAtomic(content, dest) {
    writeAtomicFile(content, dest);
  }
}
