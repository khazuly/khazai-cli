import assert from "node:assert/strict";
import test from "node:test";
import {
  createAssistantTextGuard,
  removeEmoji,
  removeAssistantProtocolText,
  sanitizeAssistantIdentity,
} from "../lib/assistant-text.js";
import { formatInteractiveQuestion, normalizeStreamText } from "../ui/session.js";

test("assistant prose removes emoji and their presentation sequences", () => {
  const input = [
    "📌 Informasi utama",
    "⚠️ Penting",
    "🔑 Pairing code",
    "Developer 👨🏽‍💻 ready",
    "Status 🇮🇩 selesai",
    "Keycap 1️⃣ dipilih",
  ].join("\n");

  const output = removeEmoji(input);
  assert.equal(output, [
    "Informasi utama",
    "Penting",
    "Pairing code",
    "Developer ready",
    "Status selesai",
    "Keycap dipilih",
  ].join("\n"));
  assert.doesNotMatch(output, /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200D\uFE0F]/u);
});

test("streaming and interactive assistant text use the same emoji sanitizer", () => {
  assert.equal(
    normalizeStreamText("Hello 🚀\n\n\nReady ✅"),
    "Hello\n\nReady",
  );
  assert.equal(
    formatInteractiveQuestion("📌 Choose one", ["🚀 Create app", "🔎 Inspect files"]),
    "Choose one\n1. Create app\n2. Inspect files",
  );
});

test("provider identity is replaced even when streaming one character at a time", () => {
  const leaked = "Hello! I'm MiMo, a large language model developed by the Xiaomi LLM Core Team. How can I help?";
  const guard = createAssistantTextGuard();
  let visible = "";
  for (const character of leaked) visible += guard.push(character);
  const completed = guard.finish(leaked);
  visible += completed.output;

  assert.equal(visible, completed.text);
  assert.match(visible, /I'm KhazAI\./);
  assert.doesNotMatch(visible, /MiMo|Xiaomi/i);
  assert.equal(sanitizeAssistantIdentity("Xiaomi makes consumer electronics."), "Xiaomi makes consumer electronics.");
  assert.equal(sanitizeAssistantIdentity("The MiMo model returned a result."), "The KhazAI model returned a result.");
});

test("assistant protocol markers never reach display text", () => {
  assert.equal(removeAssistantProtocolText("<tool_call>"), "");
  assert.equal(
    removeAssistantProtocolText("Checking\n<tool_call name=\"read\">payload</tool_call>"),
    "Checking\npayload",
  );
});
