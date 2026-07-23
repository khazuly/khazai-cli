export function normalizeVerticalWhitespace(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  let fenced = false;
  const content = lines.map(line => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    return { line, fenced };
  });
  const indentation = content
    .filter(({ line, fenced: insideCode }) => !insideCode && line.trim())
    .map(({ line }) => /^[ \t]*/.exec(line)[0].length);
  const commonIndent = indentation.length ? Math.min(...indentation) : 0;
  let blanks = 0;
  return content.map(({ line, fenced: insideCode }) => {
    const normalized = insideCode ? line : line.slice(commonIndent).replace(/[ \t]+$/, "");
    if (insideCode || normalized) {
      blanks = 0;
      return normalized;
    }
    blanks++;
    return blanks <= 1 ? "" : null;
  }).filter(line => line !== null).join("\n").replace(/^\n+|\n+$/g, "");
}
