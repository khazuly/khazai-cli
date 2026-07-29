import { ToolExecutor } from "../tool-executor.js";
import { resultFailed } from "./helpers/task.js";

export function createToolExecutor(agent, scope) {
  const executionScope = scope || agent._activeRun;
  return new ToolExecutor({
    registry: agent._registry,
    lifecycle: agent._lifecycle,
    permissionService: agent._permissionService,
    permissionHandler: request => agent._permissionHandler?.(request),
    questionHandler: question => agent._questionHandler?.(question),
    workspace: agent._workspace,
    worktree: agent._workspaceMetadata.worktree,
    sessionId: agent._sessionId,
    normalizeCall: call => agent._normalizeTool(call),
    prepareArgs: (name, args) => agent._prepareToolArgs(name, args),
    resultFailed,
    timeoutMs: agent._config.toolTimeout,
    signal: executionScope?.controller?.signal || agent._abortController?.signal,
    taskContext: agent._executionPolicy,
    runId: executionScope?.runId,
    turnId: executionScope?.turnId,
    taskEpoch: executionScope?.taskEpoch,
    isActiveRun: candidate => agent._isActiveRun(candidate),
    authorizeCall: call => agent._authorizeToolCall(call, executionScope),
    shellScheduler: agent._shellScheduler,
    protectOutput: value => agent._secretStore.protect(
      value,
      executionScope?.runId,
      executionScope?.turnId,
    ),
    protectData: value => agent._secretStore.protectSerializable(
      value,
      executionScope?.runId,
      executionScope?.turnId,
    ),
    redactOutput: value => agent.redactForDisplay(value),
  });
}
