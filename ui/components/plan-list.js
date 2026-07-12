import { createElement as h } from "react";
import { Text, Box } from "ink";
import { useState, useEffect } from "react";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function itemLine({ status, description }, frame) {
  let icon, color;
  if (status === "done")    { icon = "[✓]"; color = "green"; }
  else if (status === "failed") { icon = "[✗]"; color = "red"; }
  else if (status === "running"){ icon = `[${FRAMES[frame]}]`; color = "cyan"; }
  else                        { icon = "[ ]"; color = "white"; }

  return h(Text, { color }, " ", icon, " ", description);
}

export function PlanList({ plan }) {
  const [frame, setFrame] = useState(0);
  const hasRunning = plan.some(p => p.status === "running");
  useEffect(() => {
    if (!hasRunning) return;
    const t = setInterval(() => setFrame(x => (x + 1) % FRAMES.length), 120);
    return () => clearInterval(t);
  }, [hasRunning]);

  if (!plan || plan.length === 0) return null;

  return h(Box, {
    flexDirection: "column",
    borderStyle: "round",
    borderColor: "gray",
    paddingLeft: 1,
    paddingRight: 1,
    paddingTop: 0,
    paddingBottom: 0,
    marginTop: 1,
  },
    h(Text, { bold: true, color: "yellow" }, "# Todo"),
    ...plan.map((item, i) =>
      h(Box, { key: i, height: 1 }, itemLine(item, frame))
    )
  );
}
