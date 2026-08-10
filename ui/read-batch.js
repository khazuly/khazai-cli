import { resolve } from "node:path";

function pathKey(workspacePath, args, callId) {
  const path = String(args?.path || "").trim();
  return path ? resolve(workspacePath, path) : `call:${callId}`;
}

function displayPath(args, callId) {
  return String(args?.path || `Unknown file (${callId})`);
}

function batchId(scope, sequence) {
  return [scope?.runId, scope?.turnId, scope?.taskEpoch, sequence].join(":");
}

export function createReadBatch(scope, sequence, callId, args, startedAt) {
  const path = pathKey(scope.workspacePath, args, callId);
  return {
    id: `read-batch:${batchId(scope, sequence)}`,
    batchId: batchId(scope, sequence),
    batchSequence: sequence,
    type: "read-group",
    tool: "read",
    callIds: [callId],
    entries: [{ callId, path, displayPath: displayPath(args, callId), startedAt, finishedAt: null, failed: false }],
    total: 1,
    completed: 0,
    failed: 0,
    uniquePaths: [path],
    successfulPaths: [],
    failedPaths: [],
    startedAt,
    finishedAt: null,
    done: false,
    status: "running",
    workspacePath: scope.workspacePath,
    runId: scope?.runId,
    turnId: scope?.turnId,
    taskEpoch: scope?.taskEpoch,
  };
}

export function readBatchMatchesScope(batch, scope) {
  return batch?.runId === scope?.runId
    && batch?.turnId === scope?.turnId
    && batch?.taskEpoch === scope?.taskEpoch;
}

export function addReadToBatch(batch, callId, args, startedAt) {
  if (!batch || batch.callIds.includes(callId)) return batch;
  const path = pathKey(batch.workspacePath, args, callId);
  const uniquePaths = batch.uniquePaths.includes(path) ? batch.uniquePaths : [...batch.uniquePaths, path];
  return {
    ...batch,
    callIds: [...batch.callIds, callId],
    entries: [...batch.entries, {
      callId,
      path,
      displayPath: displayPath(args, callId),
      startedAt,
      finishedAt: null,
      failed: false,
    }],
    uniquePaths,
    total: uniquePaths.length,
    status: "running",
  };
}

export function completeReadInBatch(batch, callId, failed, finishedAt) {
  if (!batch || batch.done) return batch;
  const index = batch.entries.findIndex(entry => entry.callId === callId && entry.finishedAt === null);
  if (index < 0) return batch;
  const entry = { ...batch.entries[index], failed: Boolean(failed), finishedAt };
  const entries = batch.entries.slice();
  entries[index] = entry;
  const successful = new Set(batch.successfulPaths);
  const failures = new Set(batch.failedPaths);
  if (entry.failed) {
    failures.add(entry.path);
  } else {
    successful.add(entry.path);
  }
  return {
    ...batch,
    entries,
    completed: successful.size,
    failed: failures.size,
    successfulPaths: [...successful],
    failedPaths: [...failures],
  };
}

export function finishReadBatch(batch, finishedAt) {
  if (!batch || batch.done) return batch;
  return {
    ...batch,
    done: true,
    finishedAt,
    duration: Math.max(0, finishedAt - batch.startedAt),
  };
}
