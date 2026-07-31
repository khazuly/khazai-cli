import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { InitGenerator } from "./init-generator.js";

export const INIT_TOOLS = ["read", "glob", "grep", "websearch", "webfetch", "repo", "skill", "think"];

const SECRET_PATTERNS = [
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/i,
  /\bsk-[A-Za-z0-9_-]{12,}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}\b/i,
  /\b(?:api[_ -]?key|token|password|credential|secret|cookie|authorization)\s*(?:is\s*)?[:=]\s*["']?[^\s"'&,;]{4,}/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/,
];

export function collectInitEvidence(workspaceRoot) {
  const generator = new InitGenerator(workspaceRoot || process.cwd());
  const root = generator.detectWorkspace();
  const inspection = generator.inspect();
  return {
    workspaceRoot: root,
    inspectedFiles: [...(inspection.inspectedFiles || [])],
    directories: [...(inspection.directories || [])],
    configFiles: [...(inspection.configFiles || [])],
    scripts: [...(inspection.scripts || [])],
    entryPoints: [...(inspection.entryPoints || [])],
    packageScripts: { ...(inspection.package?.scripts || {}) },
    packageName: inspection.package?.name || null,
    description: inspection.package?.description || null,
    commands: [],
    patterns: [],
  };
}

export function buildInitTaskPrompt({
  baseline = null,
  previousEvidence = null,
  previousMarkdown = null,
  customInstruction = "",
} = {}) {
  const evidence = previousEvidence || baseline || null;
  const lines = [
    "# Internal task: repository_initialization",
    "",
    "Generate a repository-specific AGENTS.md for the current workspace.",
    "",
    "Inspect the project before writing. Determine:",
    "- project purpose",
    "- languages and runtimes",
    "- package manager",
    "- source and test structure",
    "- application entry points",
    "- build, lint, typecheck, and test commands",
    "- architecture and module boundaries",
    "- naming and coding conventions",
    "- error-handling patterns",
    "- asynchronous lifecycle rules",
    "- provider, tool, session, configuration, and UI architecture when present",
    "- repository-specific editing restrictions",
    "- verification requirements",
    "",
    "Use only verified repository evidence. Do not invent commands, directories, frameworks, conventions, or architecture.",
    "",
    "Inspection behavior:",
    "1. Start with the repository root, README.md, package manifests, lockfiles, lint/typecheck/build/test configuration, source-directory listing, test-directory listing, CI configuration, and any existing AGENTS.md.",
    "2. Read only representative and relevant files.",
    "3. Do not recursively read every source file.",
    "4. Exclude node_modules, build output, caches, generated files, .git, session storage, temporary files, binary files, and secrets or credential files.",
    "5. Use only read-only tools (read, glob, grep). Do not use bash — it is not available in this mode.",
    "6. After two failed searches for the same concept, inspect the directory or relevant files directly instead of retrying.",
    "7. Once you have enough verified evidence (typically 5-15 files), stop exploring and generate the document immediately.",
    "8. Do not read the same file twice.",
    "",
    "Generation rules:",
    "- Generate professional Markdown in English.",
    "- Keep the content specific to the repository.",
    "- Prefer concise, actionable instructions.",
    "- Do not include generic filler or placeholders.",
    "- Do not include API keys, tokens, cookies, .env values, private paths, or credentials.",
    "- Do not include rules that cannot be confirmed from the repository.",
    "- Target approximately 500-1500 words when the project has enough verified information.",
    "",
    "Recommended sections (include only relevant sections supported by evidence):",
    "# Project Overview",
    "# Repository Structure",
    "# Development Commands",
    "# Architecture and Module Boundaries",
    "# Coding Standards",
    "# Agent Editing Rules",
    "# Testing and Verification",
    "# Security and Sensitive Data",
    "# Project-Specific Notes",
    "",
  ];
  if (evidence?.workspaceRoot) {
    lines.push(`Workspace root: \`${evidence.workspaceRoot}\``);
  }
  if (evidence?.packageName) {
    lines.push(`Package: \`${evidence.packageName}\`${evidence.description ? ` — ${evidence.description}` : ""}`);
  }
  if (evidence?.directories?.length) {
    lines.push(`Source directories observed: ${evidence.directories.join(", ")}`);
  }
  if (evidence?.entryPoints?.length) {
    lines.push(`Entry points observed: ${evidence.entryPoints.join(", ")}`);
  }
  if (evidence?.configFiles?.length) {
    lines.push(`Configuration files observed: ${evidence.configFiles.join(", ")}`);
  }
  if (evidence?.scripts?.length) {
    lines.push(`Script files observed: ${evidence.scripts.join(", ")}`);
  }
  const scriptEntries = Object.entries(evidence?.packageScripts || {});
  if (scriptEntries.length) {
    lines.push("package.json scripts observed:");
    for (const [name, command] of scriptEntries) lines.push(`- ${name}: ${command}`);
  }
  if (evidence?.inspectedFiles?.length) {
    lines.push("Files already inspected:");
    for (const file of evidence.inspectedFiles.slice(0, 80)) lines.push(`- ${file}`);
  }
  if (previousMarkdown) {
    lines.push("", "A previous version was generated. Improve it while keeping every verified fact; you may reuse the evidence above instead of re-reading every file.");
  }
  if (customInstruction) {
    lines.push("", `Custom instruction from the user:`, customInstruction, "Apply it to the generated file while keeping all verified repository facts.");
  }
  lines.push(
    "",
    "Return exactly one JSON object with this shape:",
    '{ "workspaceRoot": "...", "inspectedFiles": [...], "generatedMarkdown": "...", "warnings": [...], "evidenceSummary": "..." }',
    "Put the complete AGENTS.md content inside the generatedMarkdown string. Do not write the file yourself.",
  );
  return lines.join("\n");
}

function extractFencedMarkdown(source) {
  const match = String(source).match(/```(?:markdown|md)?\s*\n([\s\S]*?)```/i);
  if (!match) return null;
  const content = match[1].trim();
  return content.startsWith("#") ? content : null;
}

export function parseInitResult(text) {
  const source = String(text || "").trim();
  if (!source) return { ok: false, error: "The model returned no content." };
  const cleaned = source
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const first = cleaned.indexOf("{");
  if (first >= 0) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let index = first; index < cleaned.length; index++) {
      const character = cleaned[index];
      if (inString) {
        if (escape) escape = false;
        else if (character === "\\") escape = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === "{") depth++;
      else if (character === "}") {
        depth--;
        if (depth === 0) {
          try {
            const result = JSON.parse(cleaned.slice(first, index + 1));
            if (result && typeof result === "object") {
              return { ok: true, result };
            }
          } catch {
            break;
          }
        }
      }
    }
  }
  if (source.startsWith("#")) {
    return {
      ok: true,
      result: {
        generatedMarkdown: source,
        warnings: ["The model returned Markdown without the structured result envelope."],
        evidenceSummary: "",
      },
      fallback: true,
    };
  }
  const fenced = extractFencedMarkdown(source);
  if (fenced) {
    return {
      ok: true,
      result: {
        generatedMarkdown: fenced,
        warnings: ["The model returned Markdown inside a fenced block."],
        evidenceSummary: "",
      },
      fallback: true,
    };
  }
  return { ok: false, error: "The model response was not structured JSON or Markdown." };
}

export function validateInitResult(result) {
  const warnings = [...(Array.isArray(result?.warnings) ? result.warnings : [])];
  const markdown = String(result?.generatedMarkdown || "").trim();
  if (!markdown) return { valid: false, error: "Generated Markdown is empty." };
  if (!markdown.startsWith("#")) return { valid: false, error: "Generated Markdown must start with a heading." };
  if (markdown.length < 60) warnings.push("Generated Markdown is very short.");
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(markdown)) return { valid: false, error: "Generated content may contain secrets." };
  }
  const wordCount = markdown.split(/\s+/).filter(Boolean).length;
  const sectionCount = (markdown.match(/^# /gm) || []).length;
  return {
    valid: true,
    warnings,
    markdown,
    wordCount,
    sectionCount,
    evidenceSummary: String(result?.evidenceSummary || "").trim().slice(0, 300),
  };
}

export function validateEvidenceReferences(markdown, evidence = {}) {
  const warnings = [];
  const scripts = new Set(Object.keys(evidence.packageScripts || {}));
  for (const match of markdown.matchAll(/npm\s+run\s+([a-zA-Z0-9:_-]+)/g)) {
    if (!scripts.has(match[1])) warnings.push(`\`npm run ${match[1]}\` was not observed in package.json scripts.`);
  }
  for (const match of markdown.matchAll(/npx\s+([a-zA-Z0-9@._/-]+)/g)) {
    if (!scripts.has(match[1])) warnings.push(`\`npx ${match[1]}\` was not observed in repository evidence.`);
  }
  const knownPaths = new Set([
    "package.json",
    "README.md",
    "AGENTS.md",
    ...(evidence.inspectedFiles || []),
    ...(evidence.configFiles || []),
    ...(evidence.scripts || []),
  ]);
  const directories = new Set(evidence.directories || []);
  for (const match of markdown.matchAll(/`([^`]+)`/g)) {
    const reference = match[1].trim();
    if (!/^[A-Za-z0-9_./-]+\.[A-Za-z0-9]+$/.test(reference)) continue;
    if (knownPaths.has(reference)) continue;
    const base = reference.split("/")[0];
    if (directories.has(base) || base === "bin" || base === "docs" || base === "scripts") continue;
    warnings.push(`Path \`${reference}\` was not observed during inspection.`);
  }
  return [...new Set(warnings)].slice(0, 8);
}

export function prepareInitPreview({ content, evidence }) {
  const parsed = parseInitResult(content);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const validation = validateInitResult(parsed.result);
  if (!validation.valid) return { ok: false, error: validation.error };
  const evidenceWarnings = validateEvidenceReferences(validation.markdown, evidence);
  const workspaceRoot = String(parsed.result.workspaceRoot || evidence?.workspaceRoot || "").trim();
  const existingPath = workspaceRoot ? join(workspaceRoot, "AGENTS.md") : null;
  let existing = null;
  if (existingPath && existsSync(existingPath)) {
    try { existing = readFileSync(existingPath, "utf-8"); } catch { existing = null; }
  }
  const warnings = [
    ...(validation.warnings || []),
    ...(evidenceWarnings || []),
    ...(Array.isArray(parsed.result.warnings) ? parsed.result.warnings : []),
  ];
  return {
    ok: true,
    markdown: validation.markdown,
    wordCount: validation.wordCount,
    sectionCount: validation.sectionCount,
    warnings: [...new Set(warnings)].slice(0, 8),
    evidenceSummary: validation.evidenceSummary,
    workspaceRoot,
    existingPath,
    existing,
  };
}

export function diffLines(before, after) {
  const a = String(before || "").split("\n");
  const b = String(after || "").split("\n");
  const rows = [];
  if (!a.length || !b.length) {
    for (const line of a) rows.push({ type: "remove", text: line });
    for (const line of b) rows.push({ type: "add", text: line });
    return rows;
  }
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j]
        ? lcs[(i + 1) * width + j + 1] + 1
        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      rows.push({ type: "remove", text: a[i] });
      i++;
    } else {
      rows.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < a.length) rows.push({ type: "remove", text: a[i++] });
  while (j < b.length) rows.push({ type: "add", text: b[j++] });
  return rows;
}
