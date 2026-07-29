export function normalizeVerticalWhitespace(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  let fenced = false;
  const content = lines.map(source => {
    const fence = /^\s*```/.test(source);
    const insideCode = fenced || fence;
    if (fence) fenced = !fenced;
    return { line: source, insideCode, fence };
  });
  const indentation = content
    .filter(({ line, insideCode, fence }) => !insideCode && !fence && line.trim())
    .map(({ line }) => /^[ \t]*/.exec(line)[0].replace(/\t/g, "  ").length);
  const commonIndent = indentation.length ? Math.min(...indentation) : 0;
  let blanks = 0;
  return content.map(({ line, insideCode, fence }) => {
    let normalized = line;
    if (fence) {
      normalized = line.trimStart().replace(/[ \t]+$/, "");
    } else if (!insideCode) {
      const indentationText = /^[ \t]*/.exec(line)[0].replace(/\t/g, "  ");
      const remainder = line.slice(/^[ \t]*/.exec(line)[0].length);
      const dedented = indentationText.slice(Math.min(commonIndent, indentationText.length));
      const keepsIndent = /^(?:[-+*]|\d+[.)])\s+/.test(remainder);
      normalized = `${keepsIndent ? dedented : ""}${remainder}`.replace(/[ \t]+$/, "");
    }
    if (insideCode || normalized) {
      blanks = 0;
      return normalized;
    }
    blanks++;
    return blanks <= 1 ? "" : null;
  }).filter(line => line !== null).join("\n").replace(/^\n+|\n+$/g, "");
}
