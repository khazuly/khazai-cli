import { Glob } from "bun";

const files = [...new Glob("{app,lib,tools,config,ui,scripts,bin}/**/*.{js,jsx}").scanSync(".")];
const migrationExemptions = new Set(["app/lsp.js", "tools/web.js"]);
const overLimit = [];
for (const file of files) {
  const text = await Bun.file(file).text();
  if (!migrationExemptions.has(file) && text.split("\n").length > 500) overLimit.push(file);
}
if (overLimit.length) throw new Error(`Source files over 500 lines: ${overLimit.join(", ")}`);
const result = await Bun.build({ entrypoints: files, target: "bun", outdir: ".check", write: false, throw: false, define: { BUILD_VERSION: JSON.stringify("0.0.0") } });
if (!result.success) throw new Error(result.logs.map(log => log.message).join("\n"));
