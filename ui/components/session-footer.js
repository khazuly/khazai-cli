import { createElement as h } from "react";
import { Box, Text } from "ink";
import { PromptInput } from "./prompt-input.js";
import { StatusBar } from "./status-bar.js";
import { useTheme } from "../theme.js";

export function SessionFooter({
  running,
  plan,
  activeTool = null,
  startedAt = null,
  waitingForAnswer = false,
  queueCount = 0,
  model = "",
  contextUsage = {},
  promptProps,
}) {
  const theme = useTheme();
  return h(Box, { flexDirection: "column", width: "100%" },
    h(StatusBar, {
      running: running && !waitingForAnswer,
      plan,
      activeTool,
      startedAt,
      waitingForAnswer,
      model,
      contextUsage,
    }),
    queueCount > 0
      ? h(Text, { color: theme.metadata },
          `Queued · ${queueCount} message${queueCount === 1 ? "" : "s"} pending`,
        )
      : null,
    h(PromptInput, promptProps),
  );
}
