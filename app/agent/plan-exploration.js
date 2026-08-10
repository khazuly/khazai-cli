import { toolMetadata } from "./helpers/task.js";

export function planBatchCanRunConcurrently(agent, calls) {
  return calls.length > 1
    && calls.every(call => {
      const definition = agent._registry.get(call.name);
      return definition
        && readOnlyBatchTool(call, definition);
    });
}

function readOnlyBatchTool(call, definition) {
  if (["read", "glob", "grep", "websearch", "webfetch", "repo"].includes(call.name)) return true;
  return call.name.startsWith("mcp__") && definition?.mcp?.readOnly === true;
}

function eventQueue(workerCount) {
  const entries = [];
  const waiters = [];
  let remaining = workerCount;
  const wake = value => {
    const resolve = waiters.shift();
    if (resolve) resolve(value);
    else entries.push(value);
  };
  return {
    push: wake,
    finish() {
      remaining--;
      if (remaining === 0) wake(null);
    },
    async next() {
      if (entries.length) return entries.shift();
      if (remaining === 0) return null;
      return new Promise(resolve => waiters.push(resolve));
    },
  };
}

export async function* runPlanExplorationBatch(agent, calls, scope) {
  const workers = Math.min(Math.max(1, Number(agent._config.readConcurrency) || 4), calls.length);
  const queue = eventQueue(workers);
  const results = new Map();
  let cursor = 0;
  let resultCursor = 0;
  const rememberCompletedResults = () => {
    while (resultCursor < calls.length) {
      const outcome = results.get(calls[resultCursor].id);
      if (!outcome) break;
      agent._rememberToolOutcome(outcome.call, outcome.result, outcome.failed);
      agent._toolEvidence.push({
        tool: outcome.call.name,
        args: agent._protectDataForContext(outcome.call.args, scope),
        result: outcome.result,
        failed: outcome.failed,
        metadata: outcome.metadata,
      });
      agent._pushToolMessage(outcome.call.name, outcome.call.id, outcome.result);
      agent._lastToolResult = outcome.result;
      agent._activeTask.lastToolResult = outcome.result.slice(0, 1500);
      resultCursor++;
    }
  };
  const runWorker = async () => {
    try {
      while (cursor < calls.length && agent._isActiveRun(scope)) {
        const call = calls[cursor++];
        for await (const event of agent._toolExecutor(scope).execute(call, { agent: agent._agentProfile?.name })) {
          queue.push({ call, event });
        }
      }
    } catch (error) {
      const failedCall = calls[cursor - 1];
      if (failedCall) {
        queue.push({
          call: failedCall,
          event: {
            type: "execution-result",
            call: failedCall,
            result: String(error?.message || error),
            failed: true,
            finishReason: "tool-error",
          },
        });
      }
    } finally {
      queue.finish();
    }
  };
  const tasks = Array.from({ length: workers }, runWorker);
  while (true) {
    const entry = await queue.next();
    if (!entry) break;
    if (!agent._isActiveRun(scope)) return;
    const { call, event } = entry;
    if (event.type !== "execution-result") {
      yield event;
      continue;
    }
    const result = agent._protectForContext(String(event.result), scope);
    results.set(call.id, {
      call: event.call,
      result,
      failed: Boolean(event.failed),
      metadata: toolMetadata(event.call, agent.redactForDisplay(result)),
    });
    rememberCompletedResults();
  }
  await Promise.all(tasks);
  if (!agent._isActiveRun(scope)) return;
  let failed = false;
  for (const call of calls) {
    const outcome = results.get(call.id);
    if (!outcome) continue;
    failed ||= outcome.failed;
  }
  yield agent._scopedToolEvent({ type: "context-usage", usage: agent.contextUsage() }, scope);
  for (const part of agent._lifecycle.finishStep(failed ? "tool-error" : "tool-calls")) {
    yield agent._scopedToolEvent({ type: "tool-part", part }, scope);
  }
  agent._lastToolWasExecuted = results.size > 0;
}
