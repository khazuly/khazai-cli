import { createElement as h } from "react";
import { Box } from "ink";
import { PromptInput } from "./prompt-input.js";
import { StatusBar } from "./status-bar.js";

export function SessionFooter({
  running,
  waitingForAnswer = false,
  queueCount = 0,
  model = "",
  modeStatus = null,
  contextUsage = {},
  promptProps,
}) {
  return h(Box, { flexDirection: "column", width: "100%" },
    h(PromptInput, promptProps),
    h(StatusBar, {
      running: running && !waitingForAnswer,
      waitingForAnswer,
      queueCount,
      model,
      modeStatus,
      contextUsage,
    }),
  );
}
