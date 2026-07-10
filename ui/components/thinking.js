import { createElement as h } from "react";
import { Text } from "ink";
import { useState, useEffect } from "react";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Thinking() {
  const [f, setF] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setF(x => (x + 1) % FRAMES.length), 80);
    return () => clearInterval(t);
  }, []);
  return h(Text, { dimColor: true }, FRAMES[f], " Thinking...");
}
