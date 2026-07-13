import assert from "node:assert/strict";
import test from "node:test";
import { removeEmoji } from "../lib/assistant-text.js";
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
