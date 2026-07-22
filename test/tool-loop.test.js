import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../app/agent.js";
import { Registry } from "../app/registry.js";

test("repeated failed tool calls stop before becoming a timeout loop", async () => {
  const registry = new Registry();
  let executions = 0;
  registry.register({
    name: "glob",
    description: "glob",
    parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
    async execute() {
      executions++;
      return "Tool timed out after 60000ms.";
    },
  });
  const call = JSON.stringify({ tool: "glob", args: { pattern: "*" } });
  const responses = [call, call, call];
  const agent = new Agent(registry, {
    workspace: mkdtempSync(join(tmpdir(), "khazai-timeout-loop-")),
    intentResolver: async ({ input }) => ({
      intent: "answer", category: "ANSWER", operation: "answer", requiredEvidence: [], requiresPlan: false, raw: input,
    }),
    chat: async (_messages, options) => {
      const response = responses.shift();
      if (response === undefined) throw new Error("Unexpected extra model turn");
      options.onToken?.(response);
      return response;
    },
  });

  const events = [];
  for await (const event of agent.loop("inspect the workspace")) events.push(event);

  assert.equal(executions, 2);
  assert.match(events.filter(event => event.type === "stream").map(event => event.token).join(""), /couldn't make further progress/i);
});
