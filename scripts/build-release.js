const targets = {
  "linux-x64": "bun-linux-x64-baseline",
  "linux-arm64": "bun-linux-arm64",
};
const requested = process.argv[2] || "all";
const names = requested === "all" ? Object.keys(targets) : [requested];
for (const name of names) {
  if (!targets[name]) throw new Error(`Unknown release target: ${name}`);
  const result = await Bun.build({
    entrypoints: ["./scripts/cli-entry.js"],
    compile: { target: targets[name], outfile: `./dist/khazai-ai-${name}` },
    external: ["react-devtools-core"],
    define: {
      BUILD_VERSION: JSON.stringify(process.env.npm_package_version || "0.3.0"),
      "process.env.DEV": JSON.stringify("false"),
    },
    minify: true,
    sourcemap: "linked",
  });
  if (!result.success) throw new Error(`Build failed for ${name}`);
}
