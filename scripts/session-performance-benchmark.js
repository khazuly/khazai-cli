import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import { createElement as h } from "react";
import { render } from "ink";
import { Agent } from "../app/agent.js";
import { Registry } from "../app/registry.js";
import { SessionStore } from "../app/session-store.js";
import { MessageList } from "../ui/components/message-list.js";
import { recentHistoryWindow } from "../ui/history-window.js";

function fixture(sessionId) {
  const canonical = [];
  const presentation = [];
  for (let index = 0; index < 500; index++) {
    const user = { id: `canonical-user-${index}`, role: "user", content: `request ${index} ${"x".repeat(120)}` };
    const answer = { id: `canonical-answer-${index}`, role: "assistant", content: `answer ${index} ${"y".repeat(160)}` };
    canonical.push(user, answer);
    presentation.push(
      { id: `user-${index}`, type: "user", content: user.content },
      { id: `answer-${index}`, type: "answer", content: answer.content },
    );
  }
  return {
    presentation,
    state: {
      version: 6,
      sessionId,
      messages: canonical,
      summary: "",
      parts: [],
      contextUsage: { requests: [], sessionInputTokens: 1_000, sessionOutputTokens: 500, historyRevision: 0 },
      historyRevision: 0,
      contextRevision: 0,
    },
  };
}

async function firstRenderMs(messages) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.resume();
  stderr.resume();
  const startedAt = performance.now();
  const instance = render(h(MessageList, { messages }), {
    stdout,
    stderr,
    stdin: new PassThrough(),
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await new Promise(resolve => setTimeout(resolve, 50));
  const elapsed = performance.now() - startedAt - 50;
  instance.unmount();
  instance.cleanup();
  return Math.max(0, elapsed);
}

async function run() {
  const root = mkdtempSync(join(tmpdir(), "khazai-session-benchmark-"));
  const workspace = mkdtempSync(join(tmpdir(), "khazai-session-workspace-"));
  try {
    const store = new SessionStore(workspace, root);
    const session = store.create({ model: "big-cock" });
    const data = fixture(session.id);
    store.save({ ...session, messages: data.presentation, agentState: data.state });
    const heapBefore = process.memoryUsage().heapUsed;
    const loadStartedAt = performance.now();
    const loaded = store.load(session.id);
    const sessionLoadMs = performance.now() - loadStartedAt;
    const agent = new Agent(new Registry(), {
      workspace,
      sessionId: loaded.id,
      model: loaded.model,
      sessionState: loaded.agentState,
      config: { modelSettings: {}, models: {}, contextLimit: 128_000 },
      chat: async (_messages, { onEvent }) => {
        await new Promise(resolve => setTimeout(resolve, 1));
        onEvent({ type: "first-byte" });
        onEvent({ type: "text-delta", text: "ok" });
        onEvent({ type: "finish", reason: "stop" });
        return "ok";
      },
    });
    const preparationStartedAt = performance.now();
    agent.contextUsage();
    const requestPreparationMs = performance.now() - preparationStartedAt;
    const visible = recentHistoryWindow(loaded.messages);
    const firstInkRenderMs = await firstRenderMs(visible);
    const providerStartedAt = performance.now();
    let timeToFirstTokenMs = null;
    for await (const event of agent.loop("benchmark continuation", undefined, {
      runId: "benchmark-run",
      turnId: "benchmark-turn",
      taskEpoch: 1,
    })) {
      if (event.type !== "stream") continue;
      timeToFirstTokenMs = performance.now() - providerStartedAt;
      break;
    }
    const result = {
      sessionLoadMs,
      canonicalHydrationMs: agent._hydrationMetrics?.canonicalMessageHydrationMs || 0,
      firstInkRenderMs,
      requestPreparationMs,
      timeToFirstTokenMs,
      historicalRowRenderCount: visible.length,
      peakMemoryMb: (process.memoryUsage().heapUsed - heapBefore) / 1_048_576,
    };
    console.log(JSON.stringify(Object.fromEntries(Object.entries(result).map(([key, value]) => [
      key,
      typeof value === "number" ? Math.round(value * 100) / 100 : value,
    ]))));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
}

await run();
