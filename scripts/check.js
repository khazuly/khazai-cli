import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { build } from "esbuild";

const ROOT = join(import.meta.dirname, "..");
const DIRS = ["app", "lib", "tools", "config", "ui", "scripts", "bin"];

function globFiles(dir, pattern, base = ROOT) {
  const results = [];
  for (const entry of readdirSync(join(base, dir), { withFileTypes: true })) {
    const full = join(base, dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...globFiles(join(dir, entry.name), pattern, base));
    } else if (pattern.test(extname(entry.name))) {
      results.push(relative(ROOT, full));
    }
  }
  return results;
}

const files = [];
for (const dir of DIRS) {
  if (statSync(join(ROOT, dir), { throwIfNoEntry: false })?.isDirectory()) {
    files.push(...globFiles(dir, /^\.(?:js|jsx)$/));
  }
}

const migrationExemptions = new Set(["app/lsp.js", "tools/web.js"]);
const overLimit = [];
for (const file of files) {
  const text = readFileSync(join(ROOT, file), "utf-8");
  if (!migrationExemptions.has(file) && text.split("\n").length > 500) overLimit.push(file);
}
if (overLimit.length) throw new Error(`Source files over 500 lines: ${overLimit.join(", ")}`);

const result = await build({
  entryPoints: files,
  outdir: join(ROOT, ".check"),
  write: false,
  bundle: true,
  platform: "node",
  format: "esm",
  define: { BUILD_VERSION: JSON.stringify("0.0.0") },
  logLevel: "error",
});
