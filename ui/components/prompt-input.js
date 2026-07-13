import { createElement as h } from "react";
import { Text, Box, useInput, useStdout } from "ink";
import { useState } from "react";
import {
  GITHUB_DARK_BACKGROUND,
  GITHUB_DARK_TEXT,
  PANEL_HORIZONTAL_PADDING,
  PANEL_END,
  PANEL_SPACE,
  panelBlankLine,
} from "../dark-panel.js";
import { PASTEL } from "../palette.js";

const segmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

function graphemes(text) {
  return segmenter
    ? Array.from(segmenter.segment(text), ({ segment }) => segment)
    : Array.from(text);
}

function insertText(state, text) {
  const value = graphemes(state.value);
  const inserted = graphemes(text);
  return {
    value: [...value.slice(0, state.cursor), ...inserted, ...value.slice(state.cursor)].join(""),
    cursor: state.cursor + inserted.length,
  };
}

function removeBackward(state) {
  if (state.cursor === 0) return state;
  const value = graphemes(state.value);
  return {
    value: [...value.slice(0, state.cursor - 1), ...value.slice(state.cursor)].join(""),
    cursor: state.cursor - 1,
  };
}

function moveVertical(state, direction) {
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

function printableText(input) {
  return graphemes(input.replace(/\r\n?/g, "\n"))
    .filter(char => char === "\n" || char >= " ")
    .join("");
}

function layoutEditableText(value, cursor, width) {
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

function findSubCommands(commands, input) {
  const slashIdx = input.indexOf("/");
  if (slashIdx < 0) return null;
  const beforeSpace = input.slice(slashIdx).split(" ")[0];
  const cmd = commands.find(c => c.name === beforeSpace);
  if (cmd && cmd.sub) return { cmd, items: cmd.sub };
  return null;
}

function filterItems(items, input, prefixLen) {
  const partial = input.slice(prefixLen).toLowerCase();
  if (!partial) return items;
  return items.filter(item =>
    item.name.toLowerCase().includes(partial) || item.description?.toLowerCase().includes(partial)
  );
}

export function PromptInput({ onSubmit, disabled, commands = [], onCommand, onClear, activeModel }) {
  const { stdout } = useStdout();
  const [input, setInput] = useState({ value: "", cursor: 0 });
  const [history, setHistory] = useState([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [cmdIdx, setCmdIdx] = useState(0);

  const subInfo = findSubCommands(commands, input.value);
  const inSubMode = subInfo !== null && input.value.includes(" ");
  const filtered = inSubMode
    ? filterItems(subInfo.items, input.value, input.value.lastIndexOf(" ") + 1)
    : filterItems(
        commands.filter(c => {
          if (!input.value.startsWith("/")) return false;
          const partial = input.value.slice(input.value.indexOf("/") + 1).toLowerCase();
          return !partial || c.name.slice(1).toLowerCase().startsWith(partial) || c.name.toLowerCase().startsWith("/" + partial);
        }),
        input.value,
        input.value.indexOf("/") + 1
      );

  const showCmd = filtered.length > 0 && input.value.startsWith("/");

  useInput((ch, key) => {
    if (disabled) return;

    if (showCmd) {
      if (key.return) {
        const sel = filtered[cmdIdx];
        if (!inSubMode && sel.sub) {
          const newVal = sel.name + " ";
          setInput({ value: newVal, cursor: newVal.length });
          setCmdIdx(0);
          return;
        }
        if (inSubMode) {
          onCommand(subInfo.cmd.name, sel.name);
        } else {
          onCommand(sel.name, "");
        }
        setInput({ value: "", cursor: 0 });
        setHistIdx(-1);
        setCmdIdx(0);
        return;
      }
      if (key.upArrow) {
        setCmdIdx(i => i > 0 ? i - 1 : filtered.length - 1);
        return;
      }
      if (key.downArrow) {
        setCmdIdx(i => i < filtered.length - 1 ? i + 1 : 0);
        return;
      }
      if (key.tab) {
        const sel = filtered[cmdIdx];
        if (inSubMode) {
          const spaceIdx = input.value.lastIndexOf(" ") + 1;
          setInput({ value: input.value.slice(0, spaceIdx) + sel.name + " ", cursor: input.value.slice(0, spaceIdx).length + sel.name.length + 1 });
        } else {
          setInput({ value: sel.name + " ", cursor: sel.name.length + 1 });
        }
        setCmdIdx(0);
        return;
      }
      if (ch === "\u001b" || key.escape) {
        setInput({ value: "", cursor: 0 });
        setCmdIdx(0);
        return;
      }
    }

    if (key.return) {
      if (key.shift) {
        setInput(current => insertText(current, "\n"));
        setHistIdx(-1);
        return;
      }
      const value = input.value.trim();
      if (value) {
        onSubmit(value);
        setHistory(current => [value, ...current].slice(0, 50));
        setInput({ value: "", cursor: 0 });
        setHistIdx(-1);
      }
      return;
    }

    if (key.backspace || key.delete || ch === "\x7f" || ch === "\b") {
      setInput(removeBackward);
      setHistIdx(-1);
      return;
    }
    if (key.leftArrow) {
      setInput(current => ({ ...current, cursor: Math.max(0, current.cursor - 1) }));
      return;
    }
    if (key.rightArrow) {
      setInput(current => {
        const length = graphemes(current.value).length;
        return { ...current, cursor: Math.min(length, current.cursor + 1) };
      });
      return;
    }
    if (key.upArrow) {
      if (input.value.includes("\n")) {
        setInput(current => moveVertical(current, -1));
        return;
      }
      const index = Math.min(histIdx + 1, history.length - 1);
      if (index >= 0) {
        const value = history[index];
        setHistIdx(index);
        setInput({ value, cursor: graphemes(value).length });
      }
      return;
    }
    if (key.downArrow) {
      if (input.value.includes("\n")) {
        setInput(current => moveVertical(current, 1));
        return;
      }
      if (histIdx > 0) {
        const index = histIdx - 1;
        const value = history[index];
        setHistIdx(index);
        setInput({ value, cursor: graphemes(value).length });
      } else {
        setHistIdx(-1);
        setInput({ value: "", cursor: 0 });
      }
      return;
    }
    if (key.ctrl && ch === "l") {
      onClear?.();
      return;
    }
    if (!key.ctrl && !key.meta && ch) {
      const text = printableText(ch);
      if (text) {
        setInput(current => {
          const next = insertText(current, text);
          if (!next.value.startsWith("/")) setCmdIdx(-1);
          return next;
        });
        setHistIdx(-1);
      }
    }
  });

  const terminalWidth = stdout?.columns || 80;
  const panelWidth = Math.max(12, terminalWidth);
  const sidePadding = PANEL_SPACE.repeat(PANEL_HORIZONTAL_PADDING);
  const innerWidth = Math.max(1, panelWidth - (PANEL_HORIZONTAL_PADDING * 2));
  const displayValue = input.value ? `❯ ${input.value}` : "❯ Ask KhazAI...";
  const displayCursor = input.value ? input.cursor + 2 : graphemes(displayValue).length;
  const inputRows = layoutEditableText(displayValue, displayCursor, innerWidth);

  const content = inputRows.map((row, rowIndex) => {
    const cursorOffset = row.cursorOffset;
    const before = cursorOffset === null ? row.cells.join("") : row.cells.slice(0, cursorOffset).join("");
    const cursorCharacter = cursorOffset === null ? "" : row.cells[cursorOffset] || " ";
    const after = cursorOffset === null
      ? ""
      : row.cells.slice(cursorOffset < row.cells.length ? cursorOffset + 1 : cursorOffset).join("");
    const visibleLength = row.cells.length + (cursorOffset === row.cells.length ? 1 : 0);
    const padding = PANEL_SPACE.repeat(Math.max(0, innerWidth - visibleLength));
    const firstPrefixLength = rowIndex === 0 ? Math.min(2, before.length) : 0;
    const prefix = before.slice(0, firstPrefixLength);
    const normalBefore = before.slice(firstPrefixLength);
    return h(Text, {
      key: `input-line-${rowIndex}`,
      color: GITHUB_DARK_TEXT,
      backgroundColor: GITHUB_DARK_BACKGROUND,
    },
      sidePadding,
      prefix ? h(Text, { bold: true }, prefix) : null,
      input.value ? normalBefore : h(Text, { dimColor: true }, normalBefore),
      cursorOffset === null ? null : `\u001b[5;7m${cursorCharacter}\u001b[25;27m`,
      input.value ? after : h(Text, { dimColor: true }, after),
      padding,
      sidePadding,
      PANEL_END,
    );
  });

  const cmdDropdown = showCmd
    ? h(Box, {
        flexDirection: "column",
        marginLeft: 2,
        marginBottom: 1,
        width: Math.max(20, Math.min(64, (process.stdout.columns || 80) - 2)),
      },
        ...filtered.map((item, i) => {
          const selected = i === cmdIdx;
          const name = item.name || "";
          const desc = inSubMode ? item.description || "" : item.description || "";
          const isActive = inSubMode && item.name === activeModel;
          return h(Box, { key: name, flexShrink: 0 },
            h(Text, {
              color: selected ? PASTEL.violet : undefined,
              bold: selected || isActive,
            }, selected ? "> " : "  ", name),
            desc ? h(Text, { dimColor: true }, "  ", desc) : null,
            isActive ? h(Text, { dimColor: true }, "  (active)") : null
          );
        })
      )
    : null;

  return h(Box, { flexDirection: "column", width: "100%" },
    cmdDropdown,
    h(Box, {
      flexDirection: "column",
      width: panelWidth,
      marginLeft: terminalWidth > panelWidth ? Math.floor((terminalWidth - panelWidth) / 2) : 0,
    },
      h(Text, { backgroundColor: GITHUB_DARK_BACKGROUND }, panelBlankLine(panelWidth)),
      ...content,
      h(Text, { backgroundColor: GITHUB_DARK_BACKGROUND }, panelBlankLine(panelWidth)),
    ),
    h(Text, { dimColor: true }, "Enter send · Ctrl+C exit · Ctrl+L clear")
  );
}
