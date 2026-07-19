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
};

// Map Prism token types to our color keys.
const TYPE_COLOR = {
  keyword: "keyword",
  builtin: "keyword",
  "class-name": "keyword",
  function: "keyword",
  boolean: "keyword",
  "maybe-class-name": "keyword",
  string: "string",
  "attr-value": "string",
  regex: "string",
  char: "string",
  number: "number",
  constant: "number",
  symbol: "number",
  tag: "tag",
  comment: "muted",
  prolog: "muted",
  doctype: "muted",
  cdata: "muted",
  punctuation: "muted",
  operator: "muted",
  "attr-name": "keyword",
  selector: "keyword",
  property: "keyword",
  variable: "text",
  parameter: "text",
  inserted: "added",
  deleted: "deleted",
};

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
