const EMOJI = /(?:[#*0-9]\uFE0F?\u20E3|\p{Regional_Indicator}{2}|[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200D\uFE0E\uFE0F])[ \t]?/gu;

export function removeEmoji(text) {
  return String(text ?? "")
    .replace(EMOJI, "")
    .replace(/[ \t]+$/gm, "");
}
