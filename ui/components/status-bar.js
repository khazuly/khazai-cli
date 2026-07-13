import { createElement as h } from "react";
import { Text, Box } from "ink";
import { useEffect, useState } from "react";

const WORKING_INTERVAL_MS = 320;

export function StatusBar({ running, plan = [] }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!running) return undefined;
    setFrame(0);
    const timer = setInterval(() => setFrame(current => (current + 1) % 3), WORKING_INTERVAL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [running]);

  if (!running) return null;

  const activePlan = plan.findIndex(item => item.status === "running");
  const label = activePlan >= 0 ? `Working ${activePlan + 1}/${plan.length}` : "Working";
  return h(Box, { marginBottom: 0 },
    h(Text, { bold: true }, label, ".".repeat(frame + 1)),
    h(Text, { dimColor: true }, "  Esc to cancel"),
  );
}
