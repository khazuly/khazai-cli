import { createElement as h } from "react";
import { Box } from "ink";
import { PromptInput } from "./prompt-input.js";
import { StatusBar } from "./status-bar.js";

export function SessionFooter({
  running,
  plan,
  activeTool = null,
  startedAt = null,
  waitingForAnswer = false,
  promptProps,
}) {
  return h(Box, { flexDirection: "column", width: "100%" },
    h(StatusBar, { running: running && !waitingForAnswer, plan, activeTool, startedAt }),
    h(PromptInput, promptProps),
  );
}
