import { createElement as h } from "react";
import { Text, Box, useInput, useApp } from "ink";
import { useState } from "react";

const OPTIONS = [
  { label: "Yes", value: true },
  { label: "No", value: false },
];

export function TrustPrompt({ path, onTrust }) {
  const [sel, setSel] = useState(0);
  const { exit } = useApp();

  useInput((_ch, key) => {
    if (key.leftArrow || key.rightArrow) {
      setSel(i => (i + 1) % OPTIONS.length);
    }
    if (key.return) {
      if (OPTIONS[sel].value) onTrust();
      else exit();
    }
  });

  return h(Box, { borderStyle: "round", borderColor: "gray", flexDirection: "column", padding: 1 },
    h(Text, {}, "Do you trust this directory?"),
    h(Text, { dimColor: true }, " ", path),
    h(Box, { marginTop: 1 },
      OPTIONS.map((o, i) =>
        h(Text, {
          key: o.label,
          ...(i === sel
            ? { bold: true, color: "blue", inverse: true }
            : { dimColor: true }),
          }, ` ${o.label} `)
      )
    ),
    h(Text, { dimColor: true, marginTop: 1 }, "Use ← → to select, Enter to confirm")
  );
}
