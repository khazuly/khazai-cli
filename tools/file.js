import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, extname, dirname, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { getWorkspace } from "../config/workspace.js";

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

const IMG = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"]);

const JS_BUILTINS = new Set([
  "fs", "path", "http", "https", "crypto", "url", "util", "events", "stream",
  "buffer", "assert", "child_process", "cluster", "dns", "domain", "http2",
  "net", "querystring", "readline", "repl", "string_decoder", "tls", "tty",
  "dgram", "v8", "vm", "zlib", "perf_hooks", "async_hooks", "inspector",
  "module", "process", "console", "timers", "worker_threads", "wasi",
  "os", "node:fs", "node:path", "node:http", "node:https", "node:crypto",
  "node:url", "node:util", "node:events", "node:stream", "node:buffer",
  "node:assert", "node:child_process", "node:os", "node:net", "node:tls",
  "node:readline", "node:zlib", "node:perf_hooks", "node:v8", "node:vm",
]);

const PY_BUILTINS = new Set([
  "sys", "os", "json", "re", "math", "datetime", "typing", "collections",
  "functools", "itertools", "pathlib", "logging", "hashlib", "copy", "enum",
  "dataclasses", "abc", "argparse", "inspect", "random", "string", "io",
  "base64", "csv", "html", "urllib", "http", "xml", "sqlite3", "subprocess",
  "threading", "asyncio", "socket", "ssl", "unittest", "glob", "fnmatch",
  "tempfile", "shutil", "time", "calendar", "uuid", "contextlib", "warnings",
  "gc", "textwrap", "pprint", "types", "weakref", "statistics", "decimal",
  "fractions", "numbers", "zipfile", "tarfile", "gzip", "bz2", "configparser",
  "difflib", "filecmp", "getpass", "platform", "signal", "mmap", "pickle",
  "shelve", "marshal", "struct", "codecs", "gettext", "locale", "ast",
  "compileall", "keyword", "token", "tokenize", "pkgutil", "modulefinder",
  "runpy", "__future__", "builtins", "dis", "opcode", "symtable",
  "stat", "fileinput", "linecache", "macpath", "posixpath", "ntpath",
  "genericpath", "zipimport", "py_compile", "pyclbr", "tabnanny",
  "ensurepip", "venv", "site", "tracemalloc", "profile", "pstats",
  "timeit", "optparse", "getopt", "mailcap", "mimetypes", "netrc",
  "xdrlib", "plistlib", "binhex", "uu", "quopri", "stringprep",
  "reprlib", "rlcompleter", "sched", "smtpd", "asyncore", "asynchat",
  "sunaudio", "imghdr", "audioop", "cgi", "cgitb", "wave", "chunk",
  "colorsys", "imputil", "ihooks", "rexec", "Bastion", "new", "user",
  "anydbm", "whichdb", "dbhash", "dbm", "gdbm", "dumbdbm", "bsddb",
  "fpformat", "gopherlib", "htmllib", "sgmllib", "rfc822", "mimetools",
  "multifile", "StringIO", "cStringIO",
]);

const MODULE_CACHE = new Map();

function parseImports(content, ext) {
  const modules = new Set();
  if ([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"].includes(ext)) {
    const importPatterns = [
      /import\s+(?:[\w*{},.\s]+\s+from\s+)?['"]([^'"]+)['"]/g,
      /import\s+['"]([^'"]+)['"]/g,
      /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ];
    for (const re of importPatterns) {
      let m; while ((m = re.exec(content)) !== null) modules.add(m[1]);
    }
  }
  if ([".py", ".pyw"].includes(ext)) {
    const pyPatterns = [
      /^import\s+(\S+)/gm,
      /^from\s+(\S+)\s+import/gm,
    ];
    for (const re of pyPatterns) {
      let m; while ((m = re.exec(content)) !== null) modules.add(m[1]);
    }
  }
  return [...modules];
}

function isBuiltIn(mod, ext) {
  const name = mod.split("/")[0].split(":")[0].replace(/^node:/, "");
  if ([".js", ".mjs", ".cjs", ".jsx"].includes(ext)) return JS_BUILTINS.has(name) || JS_BUILTINS.has(mod);
  if ([".py", ".pyw"].includes(ext)) return PY_BUILTINS.has(name);
  return false;
}

function isInstalled(mod, ext) {
  if ([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"].includes(ext)) {
    const base = mod.startsWith("@") ? mod.split("/").slice(0, 2).join("/") : mod.split("/")[0];
    if (MODULE_CACHE.has(base)) return MODULE_CACHE.get(base);
    try {
      require.resolve(base, { paths: [process.cwd()] });
      MODULE_CACHE.set(base, true);
      return true;
    } catch {
      MODULE_CACHE.set(base, false);
      return false;
    }
  }
  if ([".py", ".pyw"].includes(ext)) {
    if (MODULE_CACHE.has(mod)) return MODULE_CACHE.get(mod);
    const candidates = [["python3", ["-c", `import ${mod.split(".")[0]}`]], ["python", ["-c", `import ${mod.split(".")[0]}`]]];
    for (const [prog, args] of candidates) {
      const r = spawnSync(prog, args, { encoding: "utf8", timeout: 5000 });
      if (r.status === 0) {
        MODULE_CACHE.set(mod, true);
        return true;
      }
    }
    MODULE_CACHE.set(mod, false);
    return false;
  }
  return true;
}

function detectDependencies(path, content) {
  const ext = extname(path).toLowerCase();
  if (![".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts", ".py", ".pyw"].includes(ext)) return "";

  const modules = parseImports(content, ext).filter(m => !isBuiltIn(m, ext));
  if (modules.length === 0) return "";

  const missing = [];
  for (const mod of modules) {
    if (!isInstalled(mod, ext)) missing.push(mod);
  }
  if (missing.length === 0) return "";

  const isPy = [".py", ".pyw"].includes(ext);
  const cmd = isPy ? "pip install" : "npm install";
  const lines = missing.map(m => `  ${cmd} ${m}`);
  return `\n\n[Dependencies] ${missing.length} missing (file written successfully, install separately):\n${lines.join("\n")}`;
}

function requireWorkspace(path) {
  const ws = getWorkspace();
  if (!ws.trusted) return;
  const abs = resolve(process.cwd(), String(path));
  const rel = relative(ws.path, abs);
  if (rel.startsWith("..")) {
    throw new Error(`Access denied: ${abs} is outside workspace ${ws.path}`);
  }
}

function validateSource(path, content) {
  const extension = extname(path).toLowerCase();
  if (extension === ".json") {
    try {
      JSON.parse(content);
      return null;
    } catch (err) {
      return `Syntax validation failed for ${path}: ${err.message}`;
    }
  }

  const candidates = [];
  if (extension === ".py") {
    candidates.push(["python3", ["-c", "import ast, sys; ast.parse(sys.stdin.read(), filename=sys.argv[1])", String(path)]]);
    candidates.push(["python", ["-c", "import ast, sys; ast.parse(sys.stdin.read(), filename=sys.argv[1])", String(path)]]);
  } else if ([".js", ".mjs"].includes(extension)) {
    candidates.push(["node", ["--check", "-"]]);
    candidates.push(["node", ["--input-type=module", "--check", "-"]]);
  } else if (extension === ".cjs") {
    candidates.push(["node", ["--check", "-"]]);
  } else if ([".sh", ".bash", ".zsh"].includes(extension)) {
    candidates.push(["bash", ["-n"]]);
  } else {
    return null;
  }

  let lastError = "";
  for (const [program, args] of candidates) {
    const result = spawnSync(program, args, {
      input: content,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    if (result.error) continue;
    if (result.status === 0) return null;
    const diagnostic = String(result.stderr || result.stdout || "Syntax error")
      .trim()
      .split("\n")
      .map(l => l.trim())
      .filter(Boolean)
      .filter(l => !/^Node\.js\s+v/i.test(l))
      .slice(-1)[0]
      .slice(0, 500);
    lastError = `Syntax validation failed for ${path}: ${diagnostic}`;
  }
  return lastError || `Syntax validation could not run for ${path}`;
}

export { detectDependencies };
export const readTool = {
  name: "read",
  description: "Read file contents with line numbers.",
  parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["path"] },
  async execute({ path, offset = 1, limit = 2000 }) {
    const abs = resolve(process.cwd(), String(path));
    if (!existsSync(abs)) return `Error: not found: ${path}`;
    if (IMG.has(extname(abs).toLowerCase())) {
      const data = readFileSync(abs);
      return `data:image/${extname(abs).slice(1)};base64,${data.toString("base64")}`;
    }
    const content = readFileSync(abs, "utf-8");
    const lines = content.split("\n");
    const start = Math.max(0, Number(offset) - 1);
    const end = Math.min(start + Number(limit), lines.length);
    const slice = lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join("\n");
    return `File: ${path}\nLines: ${lines.length}\n${start + 1}-${end}\n\n${slice}`;
  },
};

export const writeTool = {
  name: "write",
  description: "Write content to a file.",
  parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  async execute({ path, content }) {
    requireWorkspace(path);
    const abs = resolve(process.cwd(), String(path));
    const next = String(content);
    const existing = existsSync(abs) ? readFileSync(abs, "utf-8") : null;
    if (existing === next) return `No changes to ${path}`;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, next, "utf-8");
    const validationError = validateSource(path, next);
    if (validationError) return validationError;
    const depNote = detectDependencies(path, next);
    return `Written ${next.length} bytes to ${path}${depNote}`;
  },
};

const EDITORS = [
  { name: "exact", apply: (c, o, n) => { const i = c.indexOf(o); return i < 0 ? null : c.slice(0, i) + n + c.slice(i + o.length); }},
  { name: "trimmed", apply: (c, o, n) => {
    if (!o.includes("\n")) {
      const i = c.indexOf(o.trim());
      return i < 0 ? null : c.slice(0, i) + n + c.slice(i + o.trim().length);
    }
    const cl = c.split("\n"), ol = o.split("\n"), nl = n.split("\n");
    const tol = ol.map(l => l.trim());
    for (let i = 0; i <= cl.length - ol.length; i++) {
      if (cl.slice(i, i + ol.length).map(l => l.trim()).every((l, j) => l === tol[j])) {
        const head = cl.slice(0, i).join("\n");
        const tail = cl.slice(i + ol.length).join("\n");
        return (head ? head + "\n" : "") + nl.join("\n") + (tail ? "\n" + tail : "");
      }
    }
    return null;
  }},
  { name: "fuzzy", apply: (c, o, n) => {
    const cl = c.split("\n"), ol = o.split("\n"), nl = n.split("\n");
    const th = ol.reduce((s, line) => s + Math.max(1, Math.floor(line.length * 0.3)), 0);
    let bestI = -1, bestD = Infinity;
    for (let i = 0; i <= cl.length - ol.length; i++) {
      let d = 0;
      for (let j = 0; j < ol.length; j++) d += levenshtein(cl[i + j].trim(), ol[j].trim());
      if (d < bestD) { bestD = d; bestI = i; }
    }
    if (bestI >= 0 && bestD <= th) {
      const head = cl.slice(0, bestI);
      const tail = cl.slice(bestI + ol.length);
      return (head.length ? head.join("\n") + "\n" : "") + nl.join("\n") + (tail.length ? "\n" + tail.join("\n") : "");
    }
    return null;
  }},
];

export const editTool = {
  name: "edit",
  description: "Edit a file by replacing text (exact, trimmed, or fuzzy).",
  parameters: { type: "object", properties: { path: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" } }, required: ["path", "oldString", "newString"] },
  async execute({ path, oldString, newString }) {
    requireWorkspace(path);
    const abs = resolve(process.cwd(), String(path));
    if (!existsSync(abs)) return `Error: not found: ${path}`;
    const orig = readFileSync(abs, "utf-8");
    for (const e of EDITORS) {
      const r = e.apply(orig, String(oldString), String(newString));
      if (r !== null) {
        const validationError = validateSource(path, r);
        if (validationError) return validationError;
        writeFileSync(abs, r, "utf-8");
        const depNote = detectDependencies(path, r);
        return `Edited ${path} (${e.name})${depNote}`;
      }
    }
    return `Error: text not found in ${path}`;
  },
};
