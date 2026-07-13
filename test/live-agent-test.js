import { Agent } from "../app/agent.js";
import { Registry } from "../app/registry.js";
import { readTool, writeTool, editTool } from "../tools/file.js";
import { globTool, grepTool } from "../tools/search.js";
import { bashTool } from "../tools/shell.js";
import { analyzeTool } from "../tools/analyze.js";

const MODELS = ["gpt", "claude", "qwen"];

function buildRegistry() {
  const r = new Registry();
  for (const t of [readTool, writeTool, editTool, globTool, grepTool, bashTool, analyzeTool]) r.register(t);
  return r;
}

async function testModel(shortcut) {
  const registry = buildRegistry();
  const agent = new Agent(registry, { model: shortcut, workspace: process.cwd() });
  const log = [];
  const start = Date.now();

  try {
    for await (const ev of agent.loop("list files in current directory using glob tool, then tell me what you found")) {
      log.push(ev.type);
      if (ev.type === "tool-call") {
        log.push(`  → ${ev.tool}(${JSON.stringify(ev.args)})`);
      }
      if (ev.type === "tool-result") {
        log.push(`  ← ${ev.result.slice(0, 80)}`);
      }
      if (ev.type === "answer" || ev.type === "error") {
        log.push(`  ─ ${ev.content.slice(0, 120)}`);
      }
    }
  } catch (err) {
    log.push(`  ✗ ${err.message}`);
  }

  const duration = ((Date.now() - start) / 1000).toFixed(1);
  const hasToolCall = log.some(l => l.startsWith("  → "));
  const hasAnswer = log.some(l => l.startsWith("  ─ "));
  const hasError = log.some(l => l.startsWith("  ✗ "));
  const passed = hasToolCall && (hasAnswer || log.includes("answer"));

  return { shortcut, duration, passed, log, hasToolCall, hasAnswer, hasError };
}

const results = [];
for (const m of MODELS) {
  console.log(`\n── Testing ${m} ──`);
  const r = await testModel(m);
  results.push(r);
  for (const line of r.log) console.log(line);
  console.log(`  ⏱ ${r.duration}s  ${r.passed ? "✓ PASS" : "✗ FAIL"}`);
}

console.log(`\n${"=".repeat(50)}`);
console.log("SUMMARY:");
for (const r of results) {
  const badge = r.passed ? "✓" : "✗";
  const note = r.hasError ? " (error)" : r.hasToolCall ? ` (tool: ${r.hasAnswer ? "ok" : "no answer"})` : " (no tool call)";
  console.log(`  ${badge} ${r.shortcut.padEnd(8)} ${r.duration}s${note}`);
}
