import { spawn } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";

const sleep = () => new Promise(r => setTimeout(r, 0));
const CONCURRENCY = 4;

const MAX_FILES = 80;
const MAX_EXCERPT_LINES = 120;
const MAX_MATCHES = 40;
const IGNORED_DIRECTORIES = new Set([
  ".git", "node_modules", "dist", "build", "coverage", ".next", "__pycache__", ".venv", "venv",
]);
const ANALYZED_EXTENSIONS = new Set([
  ".py", ".js", ".cjs", ".mjs", ".json", ".sh", ".bash", ".zsh",
  ".ts", ".tsx", ".jsx", ".html", ".css", ".yaml", ".yml", ".md",
]);
const STOP_WORDS = new Set([
  "about", "after", "and", "analysis", "analyze", "bug", "code", "error", "exception", "fix",
  "for", "from", "into", "issue", "please", "that", "the", "this", "with",
]);

function workspacePath(path = ".", workspace = process.cwd()) {
  const absolute = resolve(workspace, String(path));
  if (!isInsideWorkspace(absolute, workspace)) {
    throw new Error(`Access denied: ${absolute} is outside workspace ${workspace}`);
  }
  return absolute;
}

function isInsideWorkspace(path, workspace = process.cwd()) {
  const rel = relative(workspace, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`);
}

function displayPath(path) {
  const rel = relative(process.cwd(), path);
  return rel || ".";
}

function collectFiles(path, files = []) {
  if (files.length >= MAX_FILES) return files;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return files;
  if (stat.isFile()) {
    if (ANALYZED_EXTENSIONS.has(extname(path).toLowerCase())) files.push(path);
    return files;
  }
  if (!stat.isDirectory()) return files;

  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (files.length >= MAX_FILES) break;
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    if (entry.name.startsWith(".") && entry.isDirectory()) continue;
    collectFiles(resolve(path, entry.name), files);
  }
  return files;
}

function diagFormat(diag) {
  return diag.split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .filter(l => !/^Node\.js\s+v/i.test(l))
    .slice(-1)[0]
    .slice(0, 500);
}

function runCheck(program, args, content) {
  return new Promise(resolve => {
    const proc = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "", stdout = "";
    const timer = setTimeout(() => { proc.kill(); resolve("TIMEOUT"); }, 15000);
    proc.stdout.on("data", d => stdout += d);
    proc.stderr.on("data", d => stderr += d);
    proc.on("close", code => {
      clearTimeout(timer);
      if (code === 0) { resolve(null); return; }
      const diag = (stderr || stdout || "Syntax error").trim();
      resolve(diagFormat(diag) || "Syntax error");
    });
    proc.on("error", () => { clearTimeout(timer); resolve("RETRY"); });
    proc.stdin.write(content);
    proc.stdin.end();
  });
}

function buildCandidates(ext, path) {
  if (ext === ".py") {
    return [
      ["python3", ["-c", "import ast, sys; ast.parse(sys.stdin.read(), filename=sys.argv[1])", path]],
      ["python", ["-c", "import ast, sys; ast.parse(sys.stdin.read(), filename=sys.argv[1])", path]],
    ];
  }
  if ([".js", ".mjs"].includes(ext)) {
    return [
      ["node", ["--check", "-"]],
      ["node", ["--input-type=module", "--check", "-"]],
    ];
  }
  if (ext === ".cjs") return [["node", ["--check", "-"]]];
  if ([".sh", ".bash", ".zsh"].includes(ext)) return [["bash", ["-n"]]];
  return [];
}

async function syntaxDiag(path, content) {
  const ext = extname(path).toLowerCase();
  if (ext === ".json") {
    try { JSON.parse(content); return null; }
    catch (err) { return err.message; }
  }
  for (const [prog, args] of buildCandidates(ext, String(path))) {
    const r = await runCheck(prog, args, content);
    if (r === null) return null;
    if (r === "RETRY" || r === "TIMEOUT") continue;
    return r;
  }
  return null;
}

function keywords(...texts) {
  return [...new Set(texts.join(" ")
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter(term => term.length >= 3 && !STOP_WORDS.has(term)))]
    .slice(0, 12);
}

function lineContext(path, lineNumber, radius = 3) {
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf-8").split("\n");
  const start = Math.max(0, lineNumber - radius - 1);
  const end = Math.min(lines.length, lineNumber + radius);
  return {
    path,
    start: start + 1,
    lines: lines.slice(start, end),
  };
}

function formatContext(context) {
  return `${displayPath(context.path)}:${context.start}\n${context.lines
    .map((line, index) => `${context.start + index}: ${line}`)
    .join("\n")}`;
}

function locationsFromError(error) {
  const locations = [];
  const pattern = /([A-Za-z0-9_./-]+\.[A-Za-z0-9_]+):(\d+)/g;
  for (const match of String(error).matchAll(pattern)) {
    const candidate = resolve(process.cwd(), match[1]);
    if (isInsideWorkspace(candidate) && existsSync(candidate)) {
      locations.push({ path: candidate, line: Number(match[2]) });
    }
  }
  return locations;
}

function excerpt(path) {
  const lines = readFileSync(path, "utf-8").split("\n");
  const shown = lines.slice(0, MAX_EXCERPT_LINES);
  return `${displayPath(path)}:1\n${shown.map((line, index) => `${index + 1}: ${line}`).join("\n")}${
    lines.length > shown.length ? `\n… ${lines.length - shown.length} more lines` : ""
  }`;
}

const JS_BUG_PATTERNS = [
  { pattern: /catch\s*\([^)]*\)\s*\{\s*\}/g, label: "Empty catch block" },
  { pattern: /(?:^|[^=!<>])(==|!=)(?!=)\s/g, label: "Loose equality" },
  { pattern: /console\.(log|debug|info|warn|error)\s*\(/g, label: "Console statement" },
  { pattern: /\bTODO\b/g, label: "TODO comment" },
  { pattern: /\bFIXME\b/g, label: "FIXME comment" },
];
const PY_BUG_PATTERNS = [
  { pattern: /except\s*:/g, label: "Bare except clause" },
  { pattern: /print\s*\(/g, label: "Print statement" },
  { pattern: /\bTODO\b/g, label: "TODO comment" },
  { pattern: /\bFIXME\b/g, label: "FIXME comment" },
];

function detectBugs(path, content, ext) {
  const patterns = [".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"].includes(ext)
    ? JS_BUG_PATTERNS : [".py", ".pyw"].includes(ext)
    ? PY_BUG_PATTERNS : [];
  const findings = [];
  const seen = new Set();
  for (const { pattern, label } of patterns) {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      pattern.lastIndex = 0;
      if (pattern.test(lines[i])) {
        const key = `${path}:${i}:${label}`;
        if (!seen.has(key)) {
          seen.add(key);
          findings.push(`${displayPath(path)}:${i + 1}: ${label} — ${lines[i].trim().slice(0, 80)}`);
        }
      }
    }
  }
  return findings;
}

function detectDeadCode(path, content, ext) {
  const findings = [];
  const candidates = [];
  if ([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"].includes(ext)) {
    const funcDefs = content.matchAll(/(?:function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s*)?\(|(\w+)\s*=\s*(?:async\s*)?function)/g);
    for (const m of funcDefs) {
      const name = m[1] || m[2] || m[3];
      if (name && !name.startsWith("_")) {
        candidates.push({ name, index: m.index });
      }
    }
  }
  if ([".py", ".pyw"].includes(ext)) {
    const funcDefs = content.matchAll(/^def\s+(\w+)\s*\(/gm);
    for (const m of funcDefs) {
      const name = m[1];
      if (name && !name.startsWith("_")) {
        candidates.push({ name, index: m.index });
      }
    }
  }
  for (const { name, index } of candidates) {
    const defLine = content.slice(0, index).split("\n").length;
    const re = new RegExp(`\\b${name}\\s*\\(`, "g");
    let count = 0;
    let match;
    while ((match = re.exec(content)) !== null) {
      // skip the definition line itself
      const matchLine = content.slice(0, match.index).split("\n").length;
      if (matchLine !== defLine) count++;
    }
    if (count === 0) {
      findings.push(`${displayPath(path)}:${defLine}: Possibly unused "${name}"`);
    }
  }
  return findings.filter((f, i, a) => a.indexOf(f) === i);
}

function detectDuplicates(path, content) {
  const lines = content.split("\n");
  const findings = [];
  const seen = new Map();
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("/*")) continue;
    if (seen.has(trimmed)) {
      const prev = seen.get(trimmed);
      findings.push(`${displayPath(path)}:${prev + 1} and ${i + 1}: Duplicate line — ${trimmed.slice(0, 70)}`);
      if (findings.length >= 10) break;
    } else {
      seen.set(trimmed, i);
    }
  }
  return findings;
}

export const analyzeTool = {
  name: "analyze",
  description: "Analyze code, bugs, and errors without changing files or running the application. Checks syntax, error locations, relevant matches, and source context.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File or directory to analyze. Defaults to the workspace." },
      error: { type: "string", description: "Optional error message or stack trace supplied by the user." },
      query: { type: "string", description: "Optional symptom, symbol, or behavior to investigate." },
    },
  },
  async execute({ path = ".", error = "", query = "", _agentWorkspace } = {}) {
    const workspace = resolve(_agentWorkspace || process.cwd());
    let target;
    try {
      target = workspacePath(path, workspace);
    } catch (err) {
      return `Error: ${err.message}`;
    }
    if (!existsSync(target)) return `Error: not found: ${path}`;

    let files;
    try {
      files = collectFiles(target);
    } catch (err) {
      return `Error: could not analyze ${path}: ${err.message}`;
    }
    if (!files.length) return `Analysis: ${displayPath(target)}\nNo supported source files found.`;

    const sourceByFile = new Map();
    const diagnostics = [];
    const bugs = [];
    const deadCode = [];
    const duplicates = [];

    // Read all files first (fast, sync is fine)
    for (const file of files) {
      try {
        const source = readFileSync(file, "utf-8");
        sourceByFile.set(file, source);
      } catch (err) {
        diagnostics.push(`${displayPath(file)}: Could not read file: ${err.message}`);
      }
    }

    // Process syntax checks with concurrency to keep UI responsive
    const jobs = [...files];
    let completed = 0;
    const total = jobs.length;

    async function worker() {
      while (jobs.length > 0) {
        const file = jobs.shift();
        const source = sourceByFile.get(file);
        if (!source) continue;

        const ext = extname(file).toLowerCase();
        const diagnostic = await syntaxDiag(file, source);
        if (diagnostic) diagnostics.push(`${displayPath(file)}: ${diagnostic}`);

        bugs.push(...detectBugs(file, source, ext));
        deadCode.push(...detectDeadCode(file, source, ext));
        duplicates.push(...detectDuplicates(file, source));

        completed++;
        if (completed % CONCURRENCY === 0 || completed === total) await sleep();
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    const terms = keywords(query, error);
    const matches = [];
    if (terms.length) {
      let yi = 0;
      for (const [file, source] of sourceByFile) {
        yi++;
        if (yi % 5 === 0) await sleep();
        for (const [index, line] of source.split("\n").entries()) {
          const lower = line.toLowerCase();
          if (terms.some(term => lower.includes(term))) {
            matches.push(`${displayPath(file)}:${index + 1}: ${line.trim()}`);
            if (matches.length >= MAX_MATCHES) break;
          }
        }
        if (matches.length >= MAX_MATCHES) break;
      }
    }

    const contexts = locationsFromError(error)
      .map(location => lineContext(location.path, location.line))
      .filter(Boolean)
      .slice(0, 5);

    const lines = [
      `Analysis target: ${displayPath(target)}`,
      `Files inspected: ${files.length}${files.length === MAX_FILES ? " (limit reached)" : ""}`,
      "",
      "Syntax:",
      diagnostics.length
        ? diagnostics.map(item => `- ${item}`).join("\n")
        : `- No syntax errors found in ${files.length} inspected files.`,
    ];

    if (bugs.length) {
      lines.push("", `Bugs (${bugs.length}):`, ...bugs.slice(0, 30).map(b => `- ${b}`));
      if (bugs.length > 30) lines.push(`  ... ${bugs.length - 30} more`);
    }
    if (duplicates.length) {
      lines.push("", `Duplicate code (${duplicates.length}):`, ...duplicates.slice(0, 15).map(d => `- ${d}`));
    }
    if (deadCode.length) {
      lines.push("", `Possible dead code (${deadCode.length}):`, ...deadCode.slice(0, 15).map(d => `- ${d}`));
    }

    if (terms.length) {
      lines.push("", `Search terms: ${terms.join(", ")}`, "Relevant matches:");
      lines.push(matches.length ? matches.map(item => `- ${item}`).join("\n") : "- No matching source lines found.");
    }
    if (contexts.length) {
      lines.push("", "Error context:", ...contexts.map(formatContext));
    }
    if (files.length === 1) {
      lines.push("", "Source excerpt:", excerpt(files[0]));
    }
    return lines.join("\n").slice(0, 12_000);
  },
};
