import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../app/agent.js";
import { Registry } from "../app/registry.js";

const runs = Math.max(5, Number(process.argv[2] || 20));
const samples = [];

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

for (let index = 0; index < runs; index++) {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-latency-"));
  try {
    const agent = new Agent(new Registry(), {
      workspace,
      chat: async (_messages, options) => {
        options.onEvent?.({ type: "text-delta", text: "ready" });
        options.onEvent?.({ type: "finish", reason: "stop" });
        return "ready";
      },
    });
    for await (const _event of agent.loop("measure response latency")) {}
    const start = agent._latency.inputReceived;
    samples.push({
      dispatch: agent._latency.requestDispatched - start,
      firstText: agent._latency.uiFirstText - start,
      complete: agent._latency.completed - start,
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

const result = Object.fromEntries(["dispatch", "firstText", "complete"].map(metric => [
  metric,
  {
    p50: Math.round(percentile(samples.map(sample => sample[metric]), 0.5) * 10) / 10,
    p95: Math.round(percentile(samples.map(sample => sample[metric]), 0.95) * 10) / 10,
  },
]));

console.log(JSON.stringify({ runs, milliseconds: result }, null, 2));
if (result.dispatch.p50 >= 50) process.exitCode = 1;
