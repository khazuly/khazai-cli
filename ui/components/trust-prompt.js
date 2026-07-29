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

    // Arrow keys change selection
    if (key.upArrow || key.leftArrow) {
      setSelected(prev => (prev === 0 ? OPTIONS.length - 1 : prev - 1));
      return;
    }
    if (key.downArrow || key.rightArrow) {
      setSelected(prev => (prev + 1) % OPTIONS.length);
      return;
    }

    // Enter confirms
    if (key.return) {
      handleConfirm();
      return;
    }

    // Escape or n exits
    if (key.escape || input === "n" || input === "N") {
      handleExit();
      return;
    }

    // y confirms trust
    if (input === "y" || input === "Y") {
      if (confirmed.current) return;
      confirmed.current = true;
      onTrust();
      return;
    }
  });

  const columns = stdout?.columns || 80;
  const pathLines = wrapPath(path, Math.max(10, columns - 8));

  return h(Box, {
    flexDirection: "column",
    borderStyle: "round",
    borderColor: theme.primary,
    paddingX: 2,
    paddingY: 1,
    marginLeft: 1,
    marginRight: 1,
    marginTop: 1,
  },
    // Title
    h(Text, { bold: true, color: theme.primary }, "Workspace trust"),

    // Explanation
    h(Box, { marginTop: 1 },
      h(Text, { color: theme.text, wrap: "wrap" },
        "KhazAI may read, modify, and run commands in this directory.",
      ),
    ),

    // Directory section
    h(Box, { marginTop: 1, flexDirection: "column" },
      h(Text, { bold: true, color: theme.metadata }, "Directory"),
      h(Box, { flexDirection: "column", marginLeft: 2, flexShrink: 1 },
        ...pathLines.map((line, i) => h(Text, {
          key: `${i}-${line}`,
          color: theme.toolTarget,
          wrap: "wrap",
        }, line)),
      ),
    ),

    // Options
    h(Box, { flexDirection: "column", marginTop: 1 },
      ...OPTIONS.map((opt, index) =>
        h(Text, {
          key: opt.label,
          color: index === selected ? theme.secondary : theme.muted,
          bold: index === selected,
          dimColor: index !== selected,
          wrap: "wrap",
        }, index === selected ? "› " : "  ", opt.label),
      ),
    ),

    // Keyboard hints
    h(Box, { marginTop: 1 },
      h(Text, { color: theme.muted, dimColor: true },
        "↑↓ Select · Enter Confirm · Esc Exit",
      ),
    ),
  );
}
