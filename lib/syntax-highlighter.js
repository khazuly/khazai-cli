import Prism from "prismjs";
import "prismjs/components/prism-python.js";
import "prismjs/components/prism-bash.js";
import "prismjs/components/prism-json.js";
import "prismjs/components/prism-yaml.js";
import "prismjs/components/prism-typescript.js";
import "prismjs/components/prism-jsx.js";
import "prismjs/components/prism-tsx.js";
import "prismjs/components/prism-css.js";
import "prismjs/components/prism-markdown.js";
import "prismjs/components/prism-sql.js";
import "prismjs/components/prism-rust.js";
import "prismjs/components/prism-go.js";
import "prismjs/components/prism-ruby.js";
import "prismjs/components/prism-c.js";
import "prismjs/components/prism-cpp.js";
import "prismjs/components/prism-java.js";
import "prismjs/components/prism-csharp.js";
import "prismjs/components/prism-php.js";
import "prismjs/components/prism-docker.js";
import "prismjs/components/prism-toml.js";
import "prismjs/components/prism-lua.js";
import "prismjs/components/prism-kotlin.js";
import "prismjs/components/prism-hcl.js";

const LANGUAGE_ALIASES = {
  javascript: "javascript",
  js: "javascript",
  jsx: "jsx",
  typescript: "typescript",
  ts: "typescript",
  tsx: "tsx",
  python: "python",
  py: "python",
  shell: "bash",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  html: "html",
  xml: "xml",
  svg: "xml",
  css: "css",
  markdown: "markdown",
  md: "markdown",
  sql: "sql",
  rust: "rust",
  rs: "rust",
  go: "go",
  ruby: "ruby",
  rb: "ruby",
  c: "c",
  h: "c",
  cpp: "cpp",
  "c++": "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  java: "java",
  csharp: "csharp",
  cs: "csharp",
  php: "php",
  phtml: "php",
  docker: "docker",
  dockerfile: "docker",
  toml: "toml",
  lua: "lua",
  kotlin: "kotlin",
  kt: "kotlin",
  kts: "kotlin",
  hcl: "hcl",
  terraform: "hcl",
  tf: "hcl",
  tfvars: "hcl",
};

// Map Prism token types to our color keys.
const TYPE_COLOR = {
  keyword: "keyword",
  builtin: "function",
  "class-name": "type",
  namespace: "type",
  entity: "function",
  function: "function",
  "function-variable": "function",
  boolean: "keyword",
  "maybe-class-name": "type",
  string: "string",
  interpolation: "string",
  url: "string",
  "attr-value": "string",
  regex: "string",
  char: "string",
  number: "number",
  constant: "number",
  symbol: "number",
  tag: "tag",
  atrule: "keyword",
  annotation: "keyword",
  important: "keyword",
  comment: "comment",
  prolog: "comment",
  doctype: "comment",
  cdata: "comment",
  punctuation: "muted",
  operator: "operator",
  "attr-name": "property",
  selector: "property",
  property: "property",
  variable: "text",
  parameter: "text",
  inserted: "added",
  deleted: "deleted",
};

const CACHE_LIMIT = 96;
const blockCache = new Map();

/**
 * Recursively flatten Prism tokens into { text, color } pairs.
 */
function flatten(tokens, color = "text") {
  const parts = [];
  for (const tok of tokens) {
    if (typeof tok === "string") {
      parts.push({ text: tok, color });
    } else {
      const childColor = TYPE_COLOR[tok.type] || color;
      if (typeof tok.content === "string") {
        parts.push({ text: tok.content, color: childColor });
      } else {
        parts.push(...flatten(tok.content, childColor));
      }
    }
  }
  return parts;
}

function splitLines(parts) {
  const lines = [[]];
  for (const part of parts) {
    const chunks = String(part.text).replace(/\r\n?/g, "\n").split("\n");
    chunks.forEach((chunk, index) => {
      if (chunk) lines.at(-1).push({ text: chunk, color: part.color });
      if (index < chunks.length - 1) lines.push([]);
    });
  }
  return lines;
}

function cacheResult(key, value) {
  blockCache.set(key, value);
  if (blockCache.size > CACHE_LIMIT) blockCache.delete(blockCache.keys().next().value);
  return value;
}

/**
 * Resolve a language identifier to a Prism-supported language key.
 * Returns "javascript" as a fallback if the language is unrecognised
 * and Prism cannot accept it.
 */
export function resolveLanguage(language) {
  const value = String(language || "").trim().toLowerCase();
  const key = LANGUAGE_ALIASES[value] || value;
  if (Prism.languages[key]) return key;
  return null;
}

/**
 * Highlight a single line of code, returning an array of
 * `{ text, color }` segments.
 *
 * @param {string} line
 * @param {string} language   A Prism-compatible language key.
 * @returns {Array<{text:string, color:string}>}
 */
export function highlightLine(line, language) {
  if (!line || !language) return [{ text: line || "", color: "text" }];
  try {
    const prismLang = Prism.languages[language];
    if (!prismLang) return [{ text: line, color: "text" }];
    const tokens = Prism.tokenize(line, prismLang);
    return flatten(tokens);
  } catch {
    return [{ text: line, color: "text" }];
  }
}

export function highlightBlock(code, language) {
  const source = String(code || "").replace(/\r\n?/g, "\n");
  if (!language || !Prism.languages[language]) return source.split("\n").map(text => [{ text, color: "text" }]);
  const key = `${language}\u0000${source}`;
  const cached = blockCache.get(key);
  if (cached) return cached.map(line => line.slice());
  try {
    const lines = splitLines(flatten(Prism.tokenize(source, Prism.languages[language])));
    return cacheResult(key, lines).map(line => line.slice());
  } catch {
    return source.split("\n").map(text => [{ text, color: "text" }]);
  }
}
