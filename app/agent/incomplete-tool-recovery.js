const MAX_RECOVERY_ATTEMPTS = 4;
const RECOVERY_PROMPT = "Continue the current task. Your previous tool JSON was incomplete and was ignored. If the latest tool result already answers the request, reply with a concise normal answer. Otherwise reply with exactly one minified JSON object in the form {\"tool\":\"name\",\"args\":{...}} using one available tool and valid arguments. Do not include markdown, prose, code fences, XML tags, or repeat the user request. Close every quote, brace, and bracket before ending.";
const FINAL_RECOVERY_PROMPT = "Stop attempting a tool call for this turn. Reply with a concise normal answer describing the current status and the next safe step. Do not output JSON, markdown, or mention provider/tool-call errors.";

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
    if (agent._incompleteToolRecovery?.finalAnswer) {
      agent._incompleteToolRecovery = { attempts, pending: false, finalAnswer: false };
      return {
        handled: true,
        terminal: true,
        answer: "I could not produce a safe complete tool call for this request. Please retry with a narrower target or ask for a direct explanation.",
        diagnostic: diagnostic(partial, attempts, "answered"),
      };
    }
    agent._incompleteToolRecovery = { attempts: attempts + 1, pending: true, finalAnswer: true };
    agent._appendMessage({ role: "user", content: FINAL_RECOVERY_PROMPT });
    return { handled: true, terminal: false, diagnostic: diagnostic(partial, attempts + 1, "fallback-answer") };
  }
  agent._incompleteToolRecovery = { attempts: attempts + 1, pending: true, finalAnswer: false };
  agent._appendMessage({ role: "user", content: RECOVERY_PROMPT });
  return { handled: true, terminal: false, diagnostic: diagnostic(partial, attempts + 1) };
}

export function completeIncompleteToolRecovery(agent) {
  if (!agent._incompleteToolRecovery?.pending) return null;
  const attempts = agent._incompleteToolRecovery.attempts;
  agent._incompleteToolRecovery = { attempts, pending: false, finalAnswer: false };
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
