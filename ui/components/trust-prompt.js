import { createElement as h } from "react";
import { Text, Box, useInput, useApp } from "ink";
import { useState } from "react";
import { PASTEL } from "../palette.js";

const OPTIONS = [
  { label: "Yes", value: true },
  { label: "No", value: false },
];

export function TrustPrompt({ path, onTrust }) {
  const [selected, setSelected] = useState(0);
  const { exit } = useApp();
  useInput((_input, key) => {
    if (key.leftArrow || key.rightArrow) setSelected(index => (index + 1) % OPTIONS.length);
    if (key.return) OPTIONS[selected].value ? onTrust() : exit();
  });

  return h(Box, { flexDirection: "column" },
    h(Text, { bold: true }, "Trust this directory?"),
    h(Text, { dimColor: true, wrap: "wrap" }, path),
    h(Box, { marginTop: 1 },
      ...OPTIONS.map((option, index) => h(Text, {
        key: option.label,
        bold: index === selected,
        color: index === selected ? PASTEL.violet : undefined,
        dimColor: index !== selected,
      }, `${index === selected ? ">" : " "} ${option.label}  `))
    ),
    h(Text, { dimColor: true }, "Arrows select · Enter confirm")
  );
}
