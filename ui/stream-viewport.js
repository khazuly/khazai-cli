import stringWidth from "string-width";

export function streamViewportText(text, columns, maximumRows) {
  const width = Math.max(8, Math.trunc(Number(columns) || 80) - 1);
  const rowLimit = Math.max(1, Math.trunc(Number(maximumRows) || 1));
  const rows = [];
  for (const line of String(text || "").split("\n")) {
    if (!line) {
      rows.push("");
      continue;
    }
    let row = "";
    let rowWidth = 0;
    for (const character of Array.from(line)) {
      const characterWidth = stringWidth(character);
      if (row && rowWidth + characterWidth > width) {
        rows.push(row);
        row = "";
        rowWidth = 0;
      }
      row += character;
      rowWidth += characterWidth;
    }
    rows.push(row);
  }
  if (rows.length <= rowLimit) return rows.join("\n");
  if (rowLimit === 1) {
    let visible = "… ";
    for (const character of Array.from(rows.at(-1) || "")) {
      if (stringWidth(visible) + stringWidth(character) > width) break;
      visible += character;
    }
    return visible;
  }
  return ["…", ...rows.slice(-(rowLimit - 1))].join("\n");
}
