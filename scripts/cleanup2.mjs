import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const EXCLUDE_DIRS = new Set(["node_modules", "dist", ".git", "coverage", "session-data"]);

function findJSFiles(dir) {
  const results = [];
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        if (!EXCLUDE_DIRS.has(entry) && !entry.startsWith(".")) results.push(...findJSFiles(full));
      } else if (entry.endsWith(".js") || entry.endsWith(".mjs")) {
        results.push(full);
      }
    }
  } catch {}
  return results;
}

function stripComments(code) {
  const output = [];
  let i = 0;
  let lineStart = 0;
  const len = code.length;
  let inSingleLineComment = false;
  let inMultiLineComment = false;
  let inString = false;
  let stringChar = null;
  let inRegex = false;

  function newline() {
    output.push("\n");
    lineStart = output.length;
  }

  while (i < len) {
    const c = code[i];
    const n = i + 1 < len ? code[i + 1] : null;

    if (inSingleLineComment) {
      if (c === "\n") {
        inSingleLineComment = false;
        newline();
        i++;
        continue;
      }
      i++;
      continue;
    }

    if (inMultiLineComment) {
      if (c === "*" && n === "/") {
        inMultiLineComment = false;
        i += 2;
        continue;
      }
      if (c === "\n") {
        newline();
      }
      i++;
      continue;
    }

    if (inString) {
      output.push(c);
      if (c === "\\" && n !== null) {
        output.push(n);
        i += 2;
        continue;
      }
      if (c === stringChar) {
        inString = false;
      }
      i++;
      continue;
    }

    if (inRegex) {
      output.push(c);
      if (c === "\\" && n !== null) {
        output.push(n);
        i += 2;
        continue;
      }
      if (c === "/" && n !== "i" && n !== "g" && n !== "m" && n !== "s" && n !== "u" && n !== "y" && !/[a-z]/.test(n)) {
        inRegex = false;
      }
      i++;
      continue;
    }


    if (c === "/" && n === "/") {
      inSingleLineComment = true;
      i += 2;
      continue;
    }


    if (c === "/" && n === "*") {
      inMultiLineComment = true;
      i += 2;
      continue;
    }


    if (c === '"' || c === "'" || c === "`") {
      inString = true;
      stringChar = c;
      output.push(c);
      i++;
      continue;
    }


    if (c === "/" && n && n !== "*" && n !== "/") {

      if (i === 0 || /[=(,:!&|?{}[; ]/.test(code[i - 1])) {
        inRegex = true;
        output.push(c);
        i++;
        continue;
      }
    }

    output.push(c);
    i++;
  }

  return output.join("");
}

const allFiles = findJSFiles(".");
console.log(`Found ${allFiles.length} JS/MJS files.`);

let changed = 0;
let errors = [];

for (const file of allFiles) {
  try {
    const original = readFileSync(file, "utf-8");
    const cleaned = stripComments(original);
    if (cleaned !== original) {

      const cleanedTrimmed = cleaned.split("\n").map(l => l.trimEnd()).join("\n").trimEnd() + "\n";
      const originalTrimmed = original.split("\n").map(l => l.trimEnd()).join("\n").trimEnd() + "\n";
      if (cleanedTrimmed !== originalTrimmed) {
        writeFileSync(file, cleanedTrimmed, "utf-8");
        changed++;

        try {
          execSync(`node -c "${file}" 2>&1`, { shell: true });
        } catch (e) {
          errors.push({ file, error: e.stderr?.toString() || e.message });

          writeFileSync(file, original, "utf-8");
        }
      }
    }
  } catch (err) {
    errors.push({ file, error: err.message });
  }
}

console.log(`Modified ${changed} files, ${errors.length} errors.`);
if (errors.length) {
  for (const { file, error } of errors) {
    console.error(`ERROR: ${file}: ${error.slice(0, 200)}`);
  }
}
