import { createElement as h } from "react";
import { Box } from "ink";
import { PromptInput } from "./prompt-input.js";
import { StatusBar } from "./status-bar.js";
import { ActivityBar } from "./activity-bar.js";

export function SessionFooter({
  running,
  waitingForAnswer = false,
  queueCount = 0,
  model = "",
  contextUsage = {},
  activityScope = null,
  promptProps,
}) {
  return h(Box, { flexDirection: "column", width: "100%" },
    h(ActivityBar, {
      running,
      waitingForAnswer,
      queueCount,
      contextUsage,
      activityScope,
    }),
    h(PromptInput, promptProps),
    h(StatusBar, {
      running,
      model,
      contextUsage,
    }),
  );
}
