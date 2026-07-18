const EMOJI = /(?:[#*0-9]\uFE0F?\u20E3|\p{Regional_Indicator}{2}|[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200D\uFE0E\uFE0F])[ \t]?/gu;

export function removeEmoji(text) {
  return String(text ?? "")
    .replace(EMOJI, "")
    .replace(/[ \t]+$/gm, "");
}

export function removeAssistantProtocolText(text) {
  return String(text ?? "")
    .replace(/<\/?\s*(?:tool_call|function_calls?|invoke)\b[^>]*>/gi, "");
}

export function sanitizeAssistantIdentity(text) {
  return String(text ?? "")
    .replace(/\b(?:I['’]m|I am|My name is)\s+MiMo\b[^.!?\n]*(?:[.!?]+|$)/gi, "I'm KhazAI.")
    .replace(/\bI (?:was|am) (?:developed|created|trained|built|powered) by (?:the )?Xiaomi(?: LLM Core Team)?\b[^.!?\n]*(?:[.!?]+|$)/gi, "I'm KhazAI.")
    .replace(/\bMy (?:creator|developer|maker) is (?:the )?Xiaomi(?: LLM Core Team)?\b[^.!?\n]*(?:[.!?]+|$)/gi, "I'm KhazAI.")
    .replace(/\bAs (?:an? )?MiMo\b/gi, "As KhazAI")
    .replace(/\bXiaomi LLM Core Team\b/gi, "KhazAI team")
    .replace(/\bMiMo\b/gi, "KhazAI");
}

export function createAssistantTextGuard(transform = sanitizeAssistantIdentity, holdback = 32) {
  let source = "";
  let emitted = 0;

  function transformed() {
    return String(transform(source) ?? "");
  }

  return {
    push(chunk) {
      source += String(chunk ?? "");
      const safe = transformed();
      const end = Math.max(emitted, safe.length - holdback);
      const output = safe.slice(emitted, end);
      emitted = end;
      return output;
    },
    finish(completeText = source) {
      source = String(completeText ?? "");
      const safe = transformed();
      const output = safe.slice(Math.min(emitted, safe.length));
      emitted = safe.length;
      return { output, text: safe };
    },
  };
}
