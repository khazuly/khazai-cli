import { build } from "esbuild";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const pkg = JSON.parse((await import("node:fs")).readFileSync(join(ROOT, "package.json"), "utf-8"));

const result = await build({
  entryPoints: [join(ROOT, "scripts/cli-entry.js")],
  outfile: join(ROOT, "dist/khazai-ai.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  external: ["react-devtools-core"],
  define: {
    BUILD_VERSION: JSON.stringify(process.env.npm_package_version || pkg.version),
    "process.env.DEV": JSON.stringify("false"),
  },
  minify: true,
  sourcemap: "linked",
});

if (!result.errors.length) console.log("Build completed: dist/khazai-ai.js");
