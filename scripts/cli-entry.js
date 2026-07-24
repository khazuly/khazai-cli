let version;
try { version = BUILD_VERSION; } catch { version = undefined; }
if (!version) {
  const { readFileSync } = await import("node:fs");
  version = readFileSync(new URL("../package.json", import.meta.url), "utf-8").match(/"version":\s*"([^"]+)"/)?.[1] || "0.0.0";
}
const args = process.argv.slice(process.argv[1]?.startsWith("-") ? 1 : 2);

if (args.includes("--version") || args.includes("-v")) {
  console.log(version);
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`khazai-ai v${version} - AI coding agent

Usage:
  khazai-ai                         Interactive TUI
  khazai-ai run "prompt"            Run one task with streaming output
  khazai-ai auth login codex         Sign in with ChatGPT for Codex models
`);
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "login" && args[2] === "codex") {
  const { loginCodex } = await import("../lib/codex-auth.js");
  console.log("Opening ChatGPT authorization in your browser…");
  await loginCodex({ onAuthorize: url => console.log(`Open this URL if the browser does not open:\n${url}`) });
  console.log("Codex connected.");
  process.exit(0);
}

if (args.length) {
  console.error("Standalone task mode is not available in this release. Start KhazAI without arguments.");
  process.exit(1);
}

const { startUI } = await import("../ui/app.js");
await startUI({ version });
