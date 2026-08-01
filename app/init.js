import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export function resolveInitTarget(workspace) {
  const workspaceRoot = realpathSync(resolve(workspace));
  const targetPath = join(workspaceRoot, "AGENTS.md");
  try {
    lstatSync(targetPath);
    return { workspaceRoot, targetPath, exists: true };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { workspaceRoot, targetPath, exists: false };
  }
}

export function buildInitTask(workspaceRoot) {
  return `Generate an AGENTS.md file that serves as a concise contributor guide for this repository.

Before writing:
- inspect only the files needed to understand the repository
- identify the actual project structure, package manager, scripts, tests, formatting tools, and conventions
- do not invent commands or architecture
- do not copy secrets, credentials, environment values, global instructions, hidden prompts, or personal configuration into the file

Document requirements:
- title: \`Repository Guidelines\`
- use clear Markdown headings
- approximately 200–400 words
- keep explanations short, direct, and repository-specific
- include useful command, path, and naming examples where confirmed
- omit sections that do not apply

Recommended sections:
- Project Structure & Module Organization
- Build, Test, and Development Commands
- Coding Style & Naming Conventions
- Testing Guidelines
- Commit & Pull Request Guidelines
- Security or Configuration Notes when relevant

Write the completed document directly to:
\`${join(workspaceRoot, "AGENTS.md")}\`

Use the normal Read, Search, safe Shell, and Write tools. Do not return the document only as prose. Do not modify any other file.`;
}

export function prepareInit(workspace) {
  const target = resolveInitTarget(workspace);
  if (target.exists) {
    return {
      ...target,
      status: "exists",
      message: "AGENTS.md already exists in this workspace.",
    };
  }
  return {
    ...target,
    status: "ready",
    task: buildInitTask(target.workspaceRoot),
  };
}

export function verifyInitTarget(workspaceRoot, targetPath) {
  const root = realpathSync(resolve(workspaceRoot));
  const target = resolve(targetPath);
  const local = relative(root, target);
  if (local === ".." || local.startsWith(`..${sep}`) || local === "") {
    return { ok: false, error: "AGENTS.md was not created inside the current workspace." };
  }
  try {
    const stat = lstatSync(target);
    if (!stat.isFile()) return { ok: false, error: "AGENTS.md was not created as a regular file." };
    if (!readFileSync(target, "utf-8").trim()) return { ok: false, error: "AGENTS.md was created but is empty." };
    return { ok: true };
  } catch {
    return { ok: false, error: "AGENTS.md was not created by the initialization task." };
  }
}
