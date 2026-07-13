export const GITHUB_DARK_BACKGROUND = "#0f0f10";
export const GITHUB_DARK_TEXT = "#e6edf3";
export const PANEL_HORIZONTAL_PADDING = 2;
export const PANEL_SPACE = " ";
// Ink trims trailing spaces. This zero-width sentinel keeps those cells in
// the render tree without producing a visible glyph in Termux fonts.
export const PANEL_END = "\u200b";

export function panelBlankLine(width) {
  return PANEL_SPACE.repeat(Math.max(0, width)) + PANEL_END;
}

export function wrapPanelText(value, width) {
  const limit = Math.max(1, width);
  const rows = [];
  for (const sourceLine of String(value).replace(/\r\n?/g, "\n").split("\n")) {
    const words = sourceLine.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      rows.push("");
      continue;
    }
    let row = "";
    for (const word of words) {
      const chunks = [];
      const characters = Array.from(word);
      for (let index = 0; index < characters.length; index += limit) {
        chunks.push(characters.slice(index, index + limit).join(""));
      }
      for (const chunk of chunks) {
        if (!row) row = chunk;
        else if (Array.from(row).length + 1 + Array.from(chunk).length <= limit) row += ` ${chunk}`;
        else {
          rows.push(row);
          row = chunk;
        }
      }
    }
    rows.push(row);
  }
  return rows.length ? rows : [""];
}

export function padPanelLine(value, width) {
  const characters = Array.from(String(value));
  return characters.slice(0, width).join("").padEnd(width, PANEL_SPACE);
}
