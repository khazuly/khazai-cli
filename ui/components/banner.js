import { createElement as h } from "react";
import { Text, Box } from "ink";

const MODEL_ALIASES = {
  gpt: "GPT-4o-mini", claude: "Claude Haiku", gemini: "Gemini Flash",
  deepseek: "DeepSeek V3", grok: "Grok-3", qwen: "Qwen 2.5",
};

const MODEL_COLORS = {
  gpt: "green", claude: "yellow", gemini: "blue",
  deepseek: "cyan", grok: "magenta", qwen: "white",
};

export function Banner({ version, model, workspace }) {
  const modelLabel = MODEL_ALIASES[model] || model;
  const modelColor = MODEL_COLORS[model] || "white";

  return h(Box, { flexDirection: "column", paddingLeft: 1, paddingRight: 1, marginBottom: 1 },
    h(Box, {},
      h(Text, { bold: true, color: "white" }, "khazai-ai"),
      h(Text, { dimColor: true }, "  v" + version),
      h(Text, { dimColor: true }, "  ·  "),
      h(Text, { color: modelColor, bold: true }, modelLabel),
    ),
    h(Text, { dimColor: true }, workspace),
  );
}
