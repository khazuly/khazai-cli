export function cleanInteractiveText(value) {
  return String(value ?? "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|[.,!?;:]|$)/g, "$1$2")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .trim();
}

export function delimiterCount(text, delimiter) {
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(delimiter, index)) !== -1) {
    let backslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) backslashes++;
    if (backslashes % 2 === 0) count++;
    index += delimiter.length;
  }
  return count;
}

export function proseLooksIncomplete(text) {
  const source = String(text || "").trimEnd();
  if (!source) return false;
  if (delimiterCount(source, "```") % 2 !== 0) return true;
  const withoutFences = source.replace(/```[\s\S]*?```/g, "");
  if (delimiterCount(withoutFences, "**") % 2 !== 0) return true;
  const withoutBold = withoutFences.replace(/\*\*[^\n]*?\*\*/g, "");
  if (delimiterCount(withoutBold, "`") % 2 !== 0) return true;
  return /(?:\[[^\]\n]*|\[[^\]\n]*\]\([^\)\n]*)$/.test(source);
}
