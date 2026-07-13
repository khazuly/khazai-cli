import { Registry } from "../app/registry.js";
import { Agent } from "../app/agent.js";
import { readTool, writeTool, editTool } from "./file.js";
import { globTool, grepTool } from "./search.js";
import { bashTool } from "./shell.js";
import { analyzeTool } from "./analyze.js";

export const taskTool = {
  name: "task",
  description: "Delegate work to a sub-agent.",
  parameters: { type: "object", properties: { description: { type: "string" }, prompt: { type: "string" } }, required: ["description", "prompt"] },
  async execute({ description, prompt, _agentWorkspace }) {
    const reg = new Registry();
    for (const t of [readTool, writeTool, editTool, globTool, grepTool, bashTool, analyzeTool]) reg.register(t);
    // A delegated task must operate in the same project, never the CLI's cwd.
    const sub = new Agent(reg, { workspace: _agentWorkspace || process.cwd() });
    let result = "";
    for await (const ev of sub.loop(String(prompt))) {
      if (ev.type === "answer") result = ev.content;
      else if (ev.type === "error") result = `Error: ${ev.content}`;
    }
    return `[Sub: ${description}]\n${result}`;
  },
};
