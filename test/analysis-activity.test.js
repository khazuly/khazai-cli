import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h } from "react";
import {
  analysisActivityMessage,
  analysisEventIsCurrent,
  clearAnalysisActivity,
  clearPublicAnalysisActivity,
  completeAnalysisActivity,
  createAnalysisActivity,
  failAnalysisActivity,
  pauseAnalysisActivity,
  startAnalysisActivity,
  updateAnalysisActivity,
  updatePublicAnalysisActivity,
} from "../ui/analysis-activity.js";
import { createPublicActivityChannel } from "../app/public-activity.js";
import { MessageList } from "../ui/components/message-list.js";
import { ThemeProvider } from "../ui/theme.js";
import {
  appendResponseDelta,
  commitResponseBuffer,
  createResponseBuffer,
  discardResponseBuffer,
  prepareRunInterruption,
  resetResponseBuffer,
  terminalRunResult,
} from "../ui/session-runtime.js";
import { renderComponent } from "./helpers/ink-render.js";

const scope = { runId: "run-1", turnId: "turn-1" };

function initialState() {
  return createAnalysisActivity({ ...scope, analysisId: "analysis-turn-1" });
}

test("analysis phases reuse one ID and aggregate only active segments", () => {
  let state = startAnalysisActivity(initialState(), scope, {
    text: "Analyzing the execution context",
  }, 1_000);
  const firstId = analysisActivityMessage(state).id;

  state = pauseAnalysisActivity(state, scope, 11_000);
  assert.equal(analysisActivityMessage(state), null);

  state = startAnalysisActivity(state, scope, { text: "Reviewing the result" }, 31_000);
  assert.equal(analysisActivityMessage(state).id, firstId);
  assert.equal(state.phase, 2);

  state = completeAnalysisActivity(state, scope, 36_000);
  const summary = analysisActivityMessage(state);
  assert.equal(summary.id, firstId);
  assert.equal(summary.accumulatedDurationMs, 15_000);
  assert.equal(summary.text, "Analysis completed");
  assert.equal(summary.done, true);
});

test("repeated active updates do not reset the phase timer", () => {
  let state = startAnalysisActivity(initialState(), scope, {}, 1_000);
  state = startAnalysisActivity(state, scope, { text: "Checking context" }, 6_000);
  state = updateAnalysisActivity(state, scope, { text: "Checking constraints", step: "Step 1 of 2" });
  state = pauseAnalysisActivity(state, scope, 11_000);

  assert.equal(state.phase, 1);
  assert.equal(state.accumulatedDurationMs, 10_000);
  assert.equal(state.text, "Checking constraints");
});

test("structured public activity overrides fallback text without changing the stable row", async () => {
  let state = startAnalysisActivity(initialState(), scope, {
    text: "Inspecting continuation after tool results",
  }, 1_000);
  const id = analysisActivityMessage(state).id;
  state = updatePublicAnalysisActivity(state, scope, "think-call-1", {
    activity: "Inspecting trust-directory input handling",
    target: "ui/trust-directory.js",
    nextAction: "Update keyboard navigation and bordered layout",
    progress: "2/4",
  });
  state = updateAnalysisActivity(state, scope, { text: "Preparing the implementation" });
  const message = analysisActivityMessage(state);
  const frame = await renderComponent(
    h(ThemeProvider, { name: "system" }, h(MessageList, { messages: [message] }))
  );

  assert.equal(message.id, id);
  assert.equal(message.toolCallId, "think-call-1");
  assert.match(frame, /Inspecting trust-directory input\s+handling/);
  assert.match(frame, /ui\/trust-directory\.js/);
  assert.match(frame, /Next: Update keyboard navigation and\s+  bordered layout · 2\/4/);
  assert.doesNotMatch(frame, /Inspecting continuation|Preparing the implementation/);

  state = pauseAnalysisActivity(state, scope, 2_000);
  assert.equal(analysisActivityMessage(state), null);
  state = startAnalysisActivity(state, scope, {}, 3_000);
  assert.equal(analysisActivityMessage(state).id, id);
  assert.equal(analysisActivityMessage(state).text, "Inspecting trust-directory input handling");

  state = clearPublicAnalysisActivity(state, scope, "think-call-1");
  assert.equal(analysisActivityMessage(state).text, "Preparing the implementation");
});

test("public activity waits for complete tool JSON and rejects stale or malformed buffers", () => {
  const channel = createPublicActivityChannel(scope, value => ({
    ...value,
    target: value.target.replace("secret-token", "[REDACTED]"),
  }));
  assert.deepEqual(channel.accept({
    type: "tool-call-delta",
    delta: [{
      index: 0,
      id: "think-fragmented",
      function: {
        name: "think",
        arguments: "{\"activity\":\"Checking Ink \\\"exports\\\"\",\"target\":\"secret-",
      },
    }],
  }), []);
  assert.deepEqual(channel.accept({
    type: "tool-call-delta",
    delta: [{ index: 0, function: { arguments: "token\",\"nextAction\":\"Update import\",\"progress\":\"3/5\"}" } }],
  }), []);
  assert.deepEqual(channel.accept({
    type: "finish",
    reason: "tool-calls",
    runId: "stale-run",
  }), []);
  assert.deepEqual(channel.accept({ type: "finish", reason: "tool-calls" }), [{
    type: "public-activity",
    toolCallId: "think-fragmented",
    publicActivity: {
      activity: "Checking Ink \"exports\"",
      target: "[REDACTED]",
      nextAction: "Update import",
      progress: "3/5",
    },
  }]);

  const malformed = createPublicActivityChannel(scope);
  malformed.accept({
    type: "tool-call-delta",
    delta: [{
      index: 0,
      id: "think-malformed",
      function: { name: "think", arguments: "{\"activity\":\"Incomplete" },
    }],
  });
  assert.deepEqual(malformed.accept({ type: "finish", reason: "tool-calls" }), []);
});

test("parallel streamed tool calls keep public activity fragments isolated", () => {
  const channel = createPublicActivityChannel(scope);
  channel.accept({
    type: "tool-call-delta",
    delta: [
      {
        index: 0,
        id: "think-1",
        function: { name: "think", arguments: "{\"activity\":\"Inspecting parser\",\"target\":\"lib/" },
      },
      {
        index: 1,
        id: "read-1",
        function: { name: "read", arguments: "{\"path\":\"README.md\"}" },
      },
    ],
  });
  channel.accept({
    type: "tool-call-delta",
    delta: [{ index: 0, function: { arguments: "providers.js\"}" } }],
  });
  const activities = channel.accept({ type: "finish", reason: "tool-calls" });

  assert.equal(activities.length, 1);
  assert.equal(activities[0].toolCallId, "think-1");
  assert.equal(activities[0].publicActivity.target, "lib/providers.js");
});
test("stale run and turn updates are ignored", () => {
  const state = startAnalysisActivity(initialState(), scope, {}, 1_000);
  const staleRun = { runId: "run-old", turnId: scope.turnId };
  const staleTurn = { runId: scope.runId, turnId: "turn-old" };

  assert.equal(pauseAnalysisActivity(state, staleRun, 9_000), state);
  assert.equal(startAnalysisActivity(state, staleTurn, {}, 9_000), state);
  assert.equal(updatePublicAnalysisActivity(state, staleRun, "stale-think", {
    activity: "Stale activity",
  }), state);
  assert.equal(analysisEventIsCurrent({ runId: "run-old" }, scope), false);
  assert.equal(analysisEventIsCurrent({ turnId: "turn-old" }, scope), false);
  assert.equal(analysisEventIsCurrent({ type: "thinking" }, scope), true);
  assert.equal(clearAnalysisActivity(state, staleRun), state);
  assert.equal(clearAnalysisActivity(state, scope), null);
});

test("completed analysis renders one compact aggregate row", async () => {
  let state = startAnalysisActivity(initialState(), scope, {}, 0);
  state = pauseAnalysisActivity(state, scope, 180_000);
  state = startAnalysisActivity(state, scope, {}, 200_000);
  state = completeAnalysisActivity(state, scope, 281_000);
  const frame = await renderComponent(
    h(ThemeProvider, { name: "system" },
      h(MessageList, { messages: [analysisActivityMessage(state)] })
    )
  );

  assert.match(frame, /\[✓\] Analysis completed · 4m 21s/);
  assert.equal((frame.match(/Analysis completed/g) || []).length, 1);
  assert.doesNotMatch(frame, /bytes|\/expand|Think/);
});

test("timeout finalizes once with the stable ID and accumulated duration", async () => {
  let state = startAnalysisActivity(initialState(), scope, {}, 0);
  state = failAnalysisActivity(state, scope, 300_000);
  const failed = analysisActivityMessage(state);
  const finalizedAgain = completeAnalysisActivity(state, scope, 400_000);
  const frame = await renderComponent(
    h(ThemeProvider, { name: "system" },
      h(MessageList, { messages: [failed] })
    )
  );

  assert.equal(failed.id, "analysis-turn-1");
  assert.equal(finalizedAgain, state);
  assert.match(frame, /\[×\] Analysis timed out · 5m 00s/);
  assert.equal((frame.match(/Analysis timed out/g) || []).length, 1);
});

test("response deltas remain private until one scoped completion", () => {
  let state = createResponseBuffer(scope);
  state = appendResponseDelta(state, scope, "The execution ");
  state = appendResponseDelta(state, scope, "context is complete.");

  assert.equal(state.finalBuffer, "The execution context is complete.");
  assert.equal(state.finalCommitted, false);

  const committed = commitResponseBuffer(state, scope);
  const duplicate = commitResponseBuffer(committed.state, scope);
  assert.equal(committed.response.content, "The execution context is complete.");
  assert.equal(committed.state.finalBuffer, "");
  assert.equal(committed.state.finalCommitted, true);
  assert.equal(duplicate.response, null);
});

test("stale, cancelled, and aborted response buffers cannot publish", () => {
  let state = createResponseBuffer(scope);
  state = appendResponseDelta(state, scope, "private partial");
  const staleScope = { runId: "old-run", turnId: scope.turnId };

  assert.equal(appendResponseDelta(state, staleScope, " leaked"), state);
  assert.equal(commitResponseBuffer(state, staleScope).response, null);

  state = resetResponseBuffer(state, scope);
  state = appendResponseDelta(state, scope, "new private partial");
  state = discardResponseBuffer(state, scope);
  assert.equal(state.finalBuffer, "");
  assert.equal(commitResponseBuffer(state, scope).response, null);
});

test("run interruption is scoped, idempotent, and discards private output", () => {
  let responseBuffer = createResponseBuffer(scope);
  responseBuffer = appendResponseDelta(responseBuffer, scope, "private partial");
  const interrupted = prepareRunInterruption({
    submitting: true,
    scope,
    cancelledRunId: null,
    responseBuffer,
  });
  const duplicate = prepareRunInterruption({
    submitting: true,
    scope,
    cancelledRunId: interrupted.runId,
    responseBuffer: interrupted.responseBuffer,
  });

  assert.equal(interrupted.accepted, true);
  assert.equal(interrupted.runId, scope.runId);
  assert.equal(interrupted.responseBuffer.status, "discarded");
  assert.equal(interrupted.responseBuffer.finalBuffer, "");
  assert.equal(duplicate.accepted, false);
});

test("terminal result ignores recovered failures and reports current gaps", () => {
  const completed = terminalRunResult({
    completionGaps: [],
    finalCommitted: true,
    finishedNormally: true,
  });
  const failed = terminalRunResult({
    completionGaps: [{ kind: "validation", description: "missing validation" }],
    finalCommitted: true,
    finishedNormally: true,
  });

  assert.deepEqual(completed, {
    status: "completed",
    unresolvedIssues: [],
    verificationPassed: true,
    finalCommitted: true,
  });
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.unresolvedIssues, ["Required verification did not complete"]);
  assert.equal(failed.verificationPassed, false);
});
