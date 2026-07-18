import { loadConfig } from "../config/index.js";
import { Registry } from "../app/registry.js";
import { Agent } from "../app/agent.js";
import { getAgentProfile } from "../app/agent-profiles.js";
import { readTool } from "./file.js";
import { globTool, grepTool } from "./search.js";
import { analyzeTool } from "./analyze.js";

function readOnlyRegistry() {
  const registry = new Registry();
  for (const tool of [readTool, globTool, grepTool, analyzeTool]) registry.register(tool);
  return registry;
}

async function runTask(task, workspace, permissionService) {
  const profile = getAgentProfile(workspace, task.agent || "explore");
  const subagent = new Agent(readOnlyRegistry(), {
    workspace,
    agentProfile: { ...profile, role: "subagent", tools: ["read", "glob", "grep", "analyze"] },
    permissionService,
  });
  let result = "";
  for await (const event of subagent.loop(String(task.prompt || task.description || ""))) {
    if (event.type === "answer") result = event.content;
    else if (event.type === "stream") result += event.token;
  }
  return `[Sub: ${task.description || profile.name}]\n${result.trim()}`;
}

async function pool(tasks, concurrency, worker) {
  const results = new Array(tasks.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const index = cursor++;
      results[index] = await worker(tasks[index]);
    }
  }));
  return results;
}

export const taskTool = {
  name: "task",
  description: "Delegate one or more independent read-only investigations to safe subagents.",
  parameters: {
    type: "object",
    properties: {
      description: { type: "string" },
      prompt: { type: "string" },
      agent: { type: "string" },
      tasks: { type: "array", items: { type: "object" } },
    },
  },
  async execute({ description, prompt, agent, tasks, _agentWorkspace }, context = {}) {
    const workspace = _agentWorkspace || process.cwd();
    const work = Array.isArray(tasks) && tasks.length ? tasks : [{ description, prompt, agent }];
    const concurrency = Math.max(1, Math.min(8, Number(loadConfig().subagentConcurrency) || 3));
    const results = await pool(work, concurrency, task => runTask(task, workspace, context.permissionService));
    return results.join("\n\n");
  },
};
