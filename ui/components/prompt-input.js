import { createElement as h } from "react";
import { Text, Box, useInput } from "ink";
import { useState } from "react";

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

export function PromptInput({ onSubmit, disabled, commands = [], onCommand, activeModel }) {
  const [input, setInput] = useState({ value: "", cursor: 0 });
  const [history, setHistory] = useState([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [cmdIdx, setCmdIdx] = useState(0);
  const chars = graphemes(input.value);

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
    if (key.ctrl && ch === "l") return;
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

  const content = input.value
    ? h(Text, { wrap: "wrap" },
        h(Text, { bold: true, color: "yellow" }, "❯ "),
        h(Text, {}, chars.slice(0, input.cursor).join("")),
        h(Text, { dimColor: true, backgroundColor: "#888" }, " "),
        h(Text, {}, chars.slice(input.cursor).join(""))
      )
    : h(Text, { wrap: "wrap" },
        h(Text, { bold: true, color: "yellow" }, "❯ "),
        h(Text, { dimColor: true }, "Type a message...")
      );

  const cmdDropdown = showCmd
    ? h(Box, {
        flexDirection: "column",
        borderStyle: "round",
        borderColor: "gray",
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 0,
        paddingBottom: 0,
        marginLeft: 2,
        width: Math.min(64, (process.stdout.columns || 80) - 4),
      },
        ...filtered.map((item, i) => {
          const selected = i === cmdIdx;
          const name = item.name || "";
          const desc = inSubMode ? item.description || "" : item.description || "";
          const isActive = inSubMode && item.name === activeModel;
          return h(Box, { key: name, height: 1 },
            h(Text, {
              color: selected ? "cyan" : "white",
              bold: selected || isActive,
            }, selected ? "❯ " : isActive ? "● " : "  ", name),
            desc ? h(Text, { dimColor: true }, "  ", desc) : null,
            isActive ? h(Text, { dimColor: true }, "  (active)") : null
          );
        })
      )
    : null;

  return h(Box, { flexDirection: "column", width: "100%" },
    h(Box, { paddingLeft: 1, paddingRight: 1 }, content),
    cmdDropdown,
    h(Text, { dimColor: true }, "─".repeat(Math.min(80, process.stdout.columns || 80)))
  );
}
