import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h } from "react";
import {
  analysisActivityMessage,
  analysisEventIsCurrent,
  clearAnalysisActivity,
  completeAnalysisActivity,
  createAnalysisActivity,
  failAnalysisActivity,
  pauseAnalysisActivity,
  startAnalysisActivity,
  updateAnalysisActivity,
} from "../ui/analysis-activity.js";
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

test("stale run and turn updates are ignored", () => {
  const state = startAnalysisActivity(initialState(), scope, {}, 1_000);
  const staleRun = { runId: "run-old", turnId: scope.turnId };
  const staleTurn = { runId: scope.runId, turnId: "turn-old" };

  assert.equal(pauseAnalysisActivity(state, staleRun, 9_000), state);
  assert.equal(startAnalysisActivity(state, staleTurn, {}, 9_000), state);
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
