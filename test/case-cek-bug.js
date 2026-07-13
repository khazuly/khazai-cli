import { Agent } from "../app/agent.js";
import { Registry } from "../app/registry.js";
import { readTool, writeTool, editTool } from "../tools/file.js";
import { globTool, grepTool } from "../tools/search.js";
import { bashTool } from "../tools/shell.js";
import { analyzeTool } from "../tools/analyze.js";

const registry = new Registry();
for (const t of [readTool, writeTool, editTool, globTool, grepTool, bashTool, analyzeTool]) registry.register(t);

const model = process.argv[2] || "gpt";
const workspace = process.argv[3] || "/public/pyclipper-web";

const agent = new Agent(registry, { model, workspace });
let turn = 0;

for await (const ev of agent.loop("check the code for bugs and duplicates")) {
  turn++;
  if (ev.type === "thinking") {

    continue;
  }
  if (ev.type === "plan") {
    for (const item of ev.items) {
      void item;
    }
    continue;
  }
  if (ev.type === "plan-update") {
    // console.log(`[PLAN-UPDATE] item ${ev.index} → ${ev.status}`);
    continue;
  }
  if (ev.type === "tool-call") {
    console.log(`[TOOL-CALL] ${ev.tool} ${JSON.stringify(ev.args)}`);
    continue;
  }
  if (ev.type === "tool-result") {
    console.log(`[TOOL-RESULT] ${ev.tool}: ${ev.result.slice(0, 200)}${ev.result.length > 200 ? "..." : ""}`);
    continue;
  }
  if (ev.type === "answer") {
    console.log(`[ANSWER] ${ev.content.slice(0, 500)}${ev.content.length > 500 ? "..." : ""}`);
    continue;
  }
  if (ev.type === "error") {
    console.log(`[ERROR] ${ev.content}`);
    continue;
  }
  console.log(`[?] ${ev.type}`, JSON.stringify(ev).slice(0, 200));
}

console.log(`\n--- COMPLETE (${turn} turns) ---`);
