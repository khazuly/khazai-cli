import { createElement as h } from "react";
import { Text, Box } from "ink";

const MODEL_ALIASES = {
  gpt: "GPT-4o-mini", claude: "Claude Haiku", gemini: "Gemini Flash",
  deepseek: "DeepSeek V3", grok: "Grok-3", qwen: "Qwen 2.5",
};

export function Banner({ version, model, workspace }) {
  const modelLabel = MODEL_ALIASES[model] || model;

  return h(Box, { borderStyle: "round", borderColor: "gray", flexDirection: "column", paddingLeft: 1, paddingRight: 1 },
    h(Box, {},
      h(Text, { bold: true }, "khazai-ai"),
      h(Text, { dimColor: true }, "  v", version)
    ),
    h(Box, {},
      h(Text, { dimColor: true }, "AI coding agent  ·  "),
      h(Text, { color: "yellow" }, modelLabel),
    ),
    h(Text, { dimColor: true }, "Workspace: ", workspace),
  );
}
