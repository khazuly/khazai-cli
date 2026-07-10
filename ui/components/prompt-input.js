import { createElement as h } from "react";
import { Text, Box, useInput } from "ink";
import { useState, useRef } from "react";

export function PromptInput({ onSubmit, disabled }) {
  const [value, setValue] = useState("");
  const [history, setHistory] = useState([]);
  const [histIdx, setHistIdx] = useState(-1);
  const cursorRef = useRef(0);

  useInput((ch, key) => {
    if (key.return) {
      const v = value.trim();
      if (v) {
        onSubmit(v);
        setHistory(h => [v, ...h].slice(0, 50));
        setValue("");
        setHistIdx(-1);
        cursorRef.current = 0;
      }
      return;
    }
    if (key.delete || key.backspace || ch === "\x7f" || ch === "\b") {
      if (cursorRef.current > 0) {
        setValue(v => v.slice(0, cursorRef.current - 1) + v.slice(cursorRef.current));
        cursorRef.current--;
      }
      return;
    }
    if (key.upArrow && !disabled) {
      const idx = Math.min(histIdx + 1, history.length - 1);
      if (idx >= 0) {
        setHistIdx(idx);
        setValue(history[idx]);
        cursorRef.current = history[idx].length;
      }
      return;
    }
    if (key.downArrow) {
      if (histIdx > 0) {
        const idx = histIdx - 1;
        setHistIdx(idx);
        setValue(history[idx]);
        cursorRef.current = history[idx].length;
      } else {
        setHistIdx(-1);
        setValue("");
        cursorRef.current = 0;
      }
      return;
    }
    if (key.ctrl && ch === "l") return;
    if (key.ctrl && ch === "w") {
      const before = value.slice(0, cursorRef.current);
      const after = value.slice(cursorRef.current);
      const trimmed = before.replace(/\s+$/, "");
      const idx = trimmed.lastIndexOf(" ") + 1;
      setValue(trimmed.slice(0, idx) + after);
      cursorRef.current = idx;
      return;
    }
    if (!key.ctrl && !key.meta && !disabled && ch && ch >= " " && ch !== "\x7f") {
      setValue(v => v.slice(0, cursorRef.current) + ch + v.slice(cursorRef.current));
      cursorRef.current++;
    }
  });

  const content = value
    ? h(Box, {},
        h(Text, { bold: true, color: "yellow" }, "❯ "),
        h(Text, {}, value),
        !disabled ? h(Text, { dimColor: true }, "█") : null
      )
    : h(Box, {},
        h(Text, { bold: true, color: "yellow" }, "❯ "),
        h(Text, { dimColor: true }, "Type a message...")
      );

  return h(Box, { borderStyle: "round", borderColor: "gray" }, content);
}
