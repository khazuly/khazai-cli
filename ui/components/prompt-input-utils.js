const segmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

export function graphemes(text) {
  return segmenter
    ? Array.from(segmenter.segment(text), ({ segment }) => segment)
    : Array.from(text);
}

export function insertText(state, text) {
  const value = graphemes(state.value);
  const inserted = graphemes(text);
  return {
    value: [...value.slice(0, state.cursor), ...inserted, ...value.slice(state.cursor)].join(""),
    cursor: state.cursor + inserted.length,
  };
}

export function removeBackward(state) {
  if (state.cursor === 0) return state;
  const value = graphemes(state.value);
  return {
    value: [...value.slice(0, state.cursor - 1), ...value.slice(state.cursor)].join(""),
    cursor: state.cursor - 1,
  };
}

export function moveVertical(state, direction) {
  const value = graphemes(state.value);
  const lineStart = (() => {
    for (let i = state.cursor - 1; i >= 0; i--) if (value[i] === "\n") return i + 1;
    return 0;
  })();
  const lineEnd = (() => {
    for (let i = state.cursor; i < value.length; i++) if (value[i] === "\n") return i;
    return value.length;
  })();
  const column = state.cursor - lineStart;
  if (direction < 0) {
    if (lineStart === 0) return state;
    const previousEnd = lineStart - 1;
    let previousStart = 0;
    for (let i = previousEnd - 1; i >= 0; i--) {
      if (value[i] === "\n") {
        previousStart = i + 1;
        break;
      }
    }
    return { ...state, cursor: Math.min(previousStart + column, previousEnd) };
  }
  if (lineEnd === value.length) return state;
  const nextStart = lineEnd + 1;
  let nextEnd = value.length;
  for (let i = nextStart; i < value.length; i++) {
    if (value[i] === "\n") {
      nextEnd = i;
      break;
    }
  }
  return { ...state, cursor: Math.min(nextStart + column, nextEnd) };
}

export function printableText(input) {
  return graphemes(input.replace(/\r\n?/g, "\n"))
    .filter(char => char === "\n" || char >= " ")
    .join("");
}

export function layoutEditableText(value, cursor, width) {
  const characters = graphemes(value);
  const rows = [];
  let cells = [];
  let cursorOffset = null;
  for (let index = 0; index <= characters.length; index++) {
    if (cells.length >= width) {
      rows.push({ cells, cursorOffset });
      cells = [];
      cursorOffset = null;
    }
    if (index === cursor) cursorOffset = cells.length;
    if (index === characters.length) break;
    if (characters[index] === "\n") {
      rows.push({ cells, cursorOffset });
      cells = [];
      cursorOffset = null;
      continue;
    }
    cells.push(characters[index]);
  }
  rows.push({ cells, cursorOffset });
  return rows;
}
