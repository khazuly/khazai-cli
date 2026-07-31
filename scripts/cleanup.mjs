import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const EXCLUDE_DIRS = new Set(["node_modules", "dist", ".git", "coverage", "session-data"]);
const INCLUDE_DIRS = ["app", "lib", "config", "tools", "ui", "scripts", "test", "bin"];

function findJSFiles(dir, base = dir) {
  const results = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        if (!EXCLUDE_DIRS.has(entry) && !entry.startsWith(".")) {
          results.push(...findJSFiles(full, base));
        }
      } else if (entry.endsWith(".js") || entry.endsWith(".mjs")) {
        results.push(full);
      }
    }
  } catch {}
  return results;
}

const allFiles = findJSFiles(".");
console.log(`Found ${allFiles.length} JS/MJS files.`);

let changed = 0;

for (const file of allFiles) {
  try {
    let code = readFileSync(file, "utf-8");
    const original = code;
    const lines = code.split("\n");
    const result = [];
    let inBlockComment = false;
    let prevLineWasEmpty = false;

    const shebangs = new Set();

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];

      if (i === 0 && line.startsWith("#!")) {
        shebangs.add(i);
      }

      if (inBlockComment) {
        const endIdx = line.indexOf("*/");
        if (endIdx >= 0) {
          inBlockComment = false;
          line = line.slice(endIdx + 2);
          if (!line.trim()) continue;
        } else {
          continue;
        }
      }

");
        if (blockEnd >= 0) {
          line = before + afterStart.slice(blockEnd + 2);
        } else {
          inBlockComment = true;
          line = before;
        }
        if (!line.trim() && inBlockComment) continue;
      }

      if (!shebangs.has(i)) {
        const commentIdx = findCommentStart(line);
        if (commentIdx >= 0) {
          line = line.slice(0, commentIdx).trimEnd();
        }
      }

      const isEmpty = !line.trim();
      if (isEmpty && prevLineWasEmpty) continue;
      prevLineWasEmpty = isEmpty;

      result.push(line);
    }

    code = result.join("\n").trimEnd();
    if (code) code += "\n";

    if (code !== original) {
      writeFileSync(file, code, "utf-8");
      changed++;
    }
  } catch (err) {
    console.error(`Error processing ${file}:`, err.message);
  }
}

console.log(`Modified ${changed} files.`);

function findCommentStart(line) {
  let inString = false;
  let stringChar = "";
  let inRegex = false;
  for (let i = 0; i < line.length - 1; i++) {
    const c = line[i];
    const n = line[i + 1];
    if (c === "\\") { i++; continue; }
    if (inString) {
      if (c === stringChar) inString = false;
      continue;
    }
    if (c === "/" && n === "/" && !inRegex) return i;
    if ((c === '"' || c === "'" || c === "`") && !inRegex) {
      inString = true;
      stringChar = c;
      continue;
    }

    if (c === "/" && i > 0 && /[=(,:!&|?{}[\s]$/.test(line[i-1])) {
      inRegex = true;
      continue;
    }
    if (inRegex && c === "/" && n !== "*") {
      inRegex = false;
      continue;
    }
  }
  return -1;
}
