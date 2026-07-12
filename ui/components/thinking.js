import { createElement as h } from "react";
import { Text, Box } from "ink";
import { useState, useEffect } from "react";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Thinking() {
  const [f, setF] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setF(x => (x + 1) % FRAMES.length), 120);
    return () => clearInterval(t);
  }, []);
  return h(Box, { height: 1 },
    h(Text, { dimColor: true }, FRAMES[f], " Thinking...")
  );
}
