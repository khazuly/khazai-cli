const MAX_RECOVERY_ATTEMPTS = 2;
const RECOVERY_PROMPT = "Continue the current task. Your previous tool JSON was incomplete. If the latest tool result already answers the request, reply with a concise normal answer. Otherwise reply with exactly one complete JSON object in the form {\"tool\":\"name\",\"args\":{...}} using one available tool and valid arguments. Do not include markdown or repeat the user request.";

function diagnostic(partial, recoveryAttempt, result = "pending") {
  return {
    kind: "incomplete-tool-call",
    requestId: String(partial?.requestId || ""),
    runId: String(partial?.runId || ""),
    turnId: String(partial?.turnId || ""),
    taskEpoch: Number(partial?.taskEpoch) || 0,
    toolCallId: String(partial?.toolCallId || ""),
    providerStreamIndex: Number(partial?.providerStreamIndex) || 0,
    finishReason: String(partial?.finishReason || ""),
    toolNameComplete: Boolean(partial?.toolNameComplete),
    argumentsComplete: Boolean(partial?.argumentsComplete),
    recoveryAttempt,
    recoveryResult: result,
  };
}

export function recoverIncompleteToolCall(agent, model, partial) {
  if (model !== "aichat/claude-haiku-4-5" || !partial) return { handled: false };
  const attempts = Number(agent._incompleteToolRecovery?.attempts) || 0;
  if (attempts >= MAX_RECOVERY_ATTEMPTS) {
    agent._incompleteToolRecovery = { attempts, pending: false };
    return { handled: true, terminal: true, diagnostic: diagnostic(partial, attempts, "failed") };
  }
  agent._incompleteToolRecovery = { attempts: attempts + 1, pending: true };
  agent._appendMessage({ role: "user", content: RECOVERY_PROMPT });
  return { handled: true, terminal: false, diagnostic: diagnostic(partial, attempts + 1) };
}

export function completeIncompleteToolRecovery(agent) {
  if (!agent._incompleteToolRecovery?.pending) return null;
  const attempts = agent._incompleteToolRecovery.attempts;
  agent._incompleteToolRecovery = { attempts, pending: false };
  return { kind: "incomplete-tool-call", recoveryAttempt: attempts, recoveryResult: "succeeded" };
}

export function incompleteToolParseDiagnostic(parsed) {
  return {
    requestId: "",
    runId: "",
    turnId: "",
    taskEpoch: 0,
    toolCallId: "",
    providerStreamIndex: 0,
    finishReason: "stop",
    toolNameComplete: false,
    argumentsComplete: false,
    kind: parsed?.kind || "truncated_json",
  };
}
