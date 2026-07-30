import { createElement as h, memo, useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import stringWidth from "string-width";
import { SPINNER_FRAMES } from "./status-bar.js";
import { useTheme } from "../theme.js";

export const TOOL_SPINNER_INTERVAL_MS = 100;
const singleCellFrames = SPINNER_FRAMES.filter(frame => stringWidth(frame) === 1);
export const TOOL_SPINNER_FRAMES = singleCellFrames.length ? singleCellFrames : ["•"];

export const ToolSpinner = memo(function ToolSpinner({
  active = false,
  color,
  label,
  scopeKey = "",
  startedAt = null,
  children = null,
}) {
  const theme = useTheme();
  const intervalRef = useRef(null);
  const [clock, setClock] = useState({ frame: 0, now: Date.now() });

  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setClock({ frame: 0, now: Date.now() });
    if (!active) return undefined;
    intervalRef.current = setInterval(() => {
      setClock(value => ({
        frame: (value.frame + 1) % TOOL_SPINNER_FRAMES.length,
        now: Date.now(),
      }));
    }, TOOL_SPINNER_INTERVAL_MS);
    intervalRef.current.unref?.();
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [active, scopeKey]);

  const frame = active ? TOOL_SPINNER_FRAMES[clock.frame] || "•" : " ";
  const elapsed = startedAt
    ? `${Math.max(0, Math.floor((clock.now - startedAt) / 1000))}s`
    : "";

  return h(Box, { flexDirection: "row", width: "100%" },
    h(Box, { width: 4, flexShrink: 0 },
      h(Text, { color: color || theme.muted }, frame),
    ),
    h(Box, { flexDirection: "column", flexGrow: 1, flexShrink: 1, minWidth: 0 },
      h(Box, { flexDirection: "row", width: "100%" },
        h(Box, { flexShrink: 1, minWidth: 0 },
          h(Text, { bold: true, color: color || theme.muted, wrap: "truncate-end" }, label),
        ),
        elapsed
          ? h(Box, { width: 8, flexShrink: 0 },
              h(Text, { bold: true, color: color || theme.muted, wrap: "truncate" }, ` · ${elapsed}`),
            )
          : null,
      ),
      children,
    ),
  );
});
