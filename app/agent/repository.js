import { execAsync } from "../../lib/exec-async.js";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { redactSecrets } from "../../lib/secrets.js";
import { normalizeIntentContract } from "../intent-resolver.js";
import { publicToolArgs, toolMetadata } from "./helpers/task.js";
import { taskState } from "./helpers/parser.js";

export class RepositoryMethods {
  async _getRemoteUrl() {
    try {
      const result = await execAsync("git remote get-url origin", {
        cwd: this._workspace,
        timeoutMs: 10_000,
      });
      return (result.stdout || "").trim() || null;
    } catch {
      return null;
    }
  }

  async _runBash(command, workdir) {
    try {
      const result = await execAsync(command, {
        cwd: workdir || this._workspace,
        timeoutMs: 30_000,
      });
      return `Exit: 0\n${redactSecrets(result.stdout || result.stderr || "")}`;
    } catch (error) {
      return `Exit: 1\n${redactSecrets([error?.stdout, error?.stderr, error?.message].filter(Boolean).join("\n"))}`;
    }
  }

  async _pushWithTemporaryCredential(command, token) {
    const directory = mkdtempSync(join(tmpdir(), "khazai-git-askpass-"));
    const askpass = join(directory, "askpass.sh");
    try {
      writeFileSync(askpass, "#!/bin/sh\nprintf '%s' \"$KHAZAI_GIT_TOKEN\"\n", { mode: 0o700 });
      chmodSync(askpass, 0o700);
      const result = await execAsync(command, {
        cwd: this._workspace,
        timeoutMs: 60_000,
        env: { GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: "0", KHAZAI_GIT_TOKEN: token },
      });
      return { ok: true, result: `Exit: 0\n${redactSecrets(result.stdout || result.stderr || "Push completed.")}` };
    } catch (error) {
      const detail = redactSecrets([error?.stdout, error?.stderr, error?.message].filter(Boolean).join("\n"));
      const auth = /auth|credential|password|token|permission denied|401|403/i.test(detail);
      return { ok: false, result: auth ? "Push failed because authentication was rejected." : "Push failed. Check the remote, branch, and connection, then try again." };
    } finally {
      try { rmSync(directory, { recursive: true, force: true }); } catch {}
    }
  }

  async *_runShellShortcut(input) {
    const executionScope = this._activeRun;
    if (!this._isActiveRun(executionScope)) return;
    const command = String(input || "").slice(1).trim();
    if (!command) {
      const answer = "Enter a command after !.";
      this._appendMessage({ role: "user", content: input });
      this._appendMessage({ role: "assistant", content: answer });
      yield { type: "stream", token: answer };
      yield { type: "stream-end" };
      return;
    }

    const protectedInput = this._protectForContext(input);
    this._taskContract = normalizeIntentContract({
      intent: "change",
      category: "SHELL_OPERATION",
      operation: "shell",
      requiredEvidence: ["shell"],
      modifiesFiles: false,
    }, protectedInput);
    this._activeTask = taskState(this._taskContract, protectedInput);
    this._currentRequest = protectedInput;
    this._activeScope = {
      sessionId: this._sessionId,
      runId: executionScope.runId,
      turnId: executionScope.turnId,
      objective: protectedInput,
      taskEpoch: executionScope.taskEpoch,
      relevantFiles: [],
      allowedTargets: [],
      currentPlan: [],
      changedFiles: [],
    };
    this._appendMessage({ role: "user", content: protectedInput });
    this._requestStartIndex = this._messages.length - 1;
    this._toolEvidence = [];
    this._toolCallHistory = [];
    this._completedToolResults.clear();
    this._invalidateInspectionCache();

    const snapshot = this._lifecycle.startStep();
    if (snapshot) yield this._scopedToolEvent({ type: "tool-part", part: snapshot }, executionScope);
    const call = {
      id: randomUUID(),
      name: "bash",
      args: { command, workdir: this._workspace },
    };
    this._shellScheduler.reserve(call);
    yield this._scopedToolEvent({ type: "tool-call", tool: call.name, args: { ...call.args }, callId: call.id }, executionScope);
    if (!this._isActiveRun(executionScope)) return;
    this._appendMessage({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(this._protectDataForContext(publicToolArgs(call.args))),
        },
      }],
    });
    let result = "";
    let failed = false;
    let finishReason = "tool-calls";
    for await (const event of this._toolExecutor(executionScope).execute(call, { agent: this._agentProfile?.name })) {
      if (event.type === "execution-result") {
        result = this._protectForContext(String(event.result || ""));
        failed = Boolean(event.failed);
        finishReason = event.finishReason;
      } else {
        yield event;
      }
    }
    if (!this._isActiveRun(executionScope)) return;
    this._pushToolMessage(call.name, call.id, result);
    this._toolEvidence.push({ tool: "bash", args: call.args, result, failed, metadata: toolMetadata(call, result) });
    this._lastToolResult = result;
    this._activeTask.lastToolResult = result.slice(0, 1500);
    for (const lifecyclePart of this._lifecycle.finishStep(finishReason)) {
      yield this._scopedToolEvent({ type: "tool-part", part: lifecyclePart }, executionScope);
    }
    const exitCode = /^Exit:\s*(-?\d+)/im.exec(result)?.[1];
    const answer = failed
      ? `Command finished with exit code ${exitCode ?? "unknown"}.`
      : `Command finished with exit code ${exitCode ?? "0"}.`;
    this._appendMessage({ role: "assistant", content: answer });
    this._finishLatency();
    yield { type: "stream", token: answer };
    yield { type: "stream-end" };
  }

}
