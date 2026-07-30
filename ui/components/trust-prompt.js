import { createElement as h, useState, useRef, useCallback } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { useTheme } from "../theme.js";

const OPTIONS = [
  { label: "Trust and continue", value: true },
  { label: "Exit without trusting", value: false },
];

function wrapPath(value, width) {
  if (!value) return [""];
  const lines = [];
  let current = "";
  for (const token of String(value).split(/(?<=[/\\_-])/)) {
    if (current && current.length + token.length > width) {
      lines.push(current);
      current = "";
    }
    let remaining = token;
    while (remaining.length > width) {
      lines.push(remaining.slice(0, width));
      remaining = remaining.slice(width);
    }
    current += remaining;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

export function TrustPrompt({ path, onTrust }) {
  const theme = useTheme();
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [selected, setSelected] = useState(0);
  const confirmed = useRef(false);

  const handleConfirm = useCallback(() => {
    if (confirmed.current) return;
    confirmed.current = true;
    if (OPTIONS[selected].value) {
      onTrust();
    } else {
      exit();
    }
  }, [selected, onTrust, exit]);

  const handleExit = useCallback(() => {
    if (confirmed.current) return;
    confirmed.current = true;
    exit();
  }, [exit]);

  useInput((input, key) => {
    if (confirmed.current) return;


    if (key.upArrow || key.leftArrow) {
      setSelected(prev => (prev === 0 ? OPTIONS.length - 1 : prev - 1));
      return;
    }
    if (key.downArrow || key.rightArrow) {
      setSelected(prev => (prev + 1) % OPTIONS.length);
      return;
    }


    if (key.return) {
      handleConfirm();
      return;
    }


    if (key.escape || input === "n" || input === "N") {
      handleExit();
      return;
    }


    if (input === "y" || input === "Y") {
      if (confirmed.current) return;
      confirmed.current = true;
      onTrust();
      return;
    }
  });

  const columns = stdout?.columns || 80;
  const contentWidth = Math.max(10, columns - 6);
  const pathLines = wrapPath(path, contentWidth);

  return h(Box, {
    flexDirection: "column",
    borderStyle: "single",
    borderColor: theme.border,
    paddingX: 2,
    paddingY: 1,
    marginTop: 1,
    width: columns,
  },

    h(Text, { bold: true, color: theme.primary }, "Workspace trust"),


    h(Text, " "),


    h(Text, { color: theme.text, wrap: "wrap" },
      "KhazAI may read, modify, and run commands in this directory.",
    ),


    h(Text, " "),


    h(Box, { flexDirection: "column" },
      h(Text, { bold: true, color: theme.metadata }, "Directory"),
      ...pathLines.map((line, i) => h(Text, {
        key: `${i}-${line}`,
        color: theme.toolTarget,
        wrap: "wrap",
      }, line)),
    ),


    h(Text, " "),


    h(Box, { flexDirection: "column" },
      ...OPTIONS.map((opt, index) =>
        h(Text, {
          key: opt.label,
          color: index === selected ? theme.primary : theme.muted,
          bold: index === selected,
          dimColor: index !== selected,
          wrap: "wrap",
        }, index === selected ? "› " : "  ", opt.label),
      ),
    ),


    h(Text, " "),


    h(Text, { color: theme.muted, dimColor: true, wrap: "wrap" },
      "↑↓ Select · Enter Confirm · Esc Exit",
    ),
  );
}
