export function normalizeVerticalWhitespace(text) {
  return String(text)
    .replace(/\r\n?/g, "\n")
    .replace(/^[^\S\n]+$/gm, "")
    .replace(/\n(?:[^\S\n]*\n){2,}/g, "\n\n")
    .replace(/^[^\S\n]*\n+/, "")
    .replace(/^[^\S\n]+/, "");
}
