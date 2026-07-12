import { createElement as h } from "react";
import { Text, Box } from "ink";

const MODEL_COSTS = {
  gpt: { input: 0.15, output: 0.60, label: "GPT-4o-mini" },
  claude: { input: 0.80, output: 4.00, label: "Claude Haiku" },
  gemini: { input: 0.075, output: 0.30, label: "Gemini Flash" },
  deepseek: { input: 0.27, output: 1.10, label: "DeepSeek V3" },
  grok: { input: 0.30, output: 0.50, label: "Grok-3" },
  qwen: { input: 0.50, output: 2.00, label: "Qwen 2.5" },
};

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function estimateCost(model, inputTokens, outputTokens) {
  const costs = MODEL_COSTS[model];
  if (!costs) return null;
  return ((inputTokens * costs.input + outputTokens * costs.output) / 1_000_000);
}

export function StatusBar({ model, messages, toolsUsed }) {
  const modelInfo = MODEL_COSTS[model];
  const label = modelInfo?.label || model;

  let totalTokens = 0;
  for (const m of messages) {
    if (m.type === "user") totalTokens += estimateTokens(m.content);
    else if (m.type === "answer") totalTokens += estimateTokens(m.content);
    else if (m.type === "tool") totalTokens += estimateTokens(m.content || "");
  }

  const cost = estimateCost(model, totalTokens, 0);
  const costStr = cost !== null ? `$${cost.toFixed(3)}` : "$0.00";

  return h(Box, { paddingLeft: 1 },
    h(Text, { dimColor: true }, label),
    h(Text, { dimColor: true }, " │ "),
    h(Text, { dimColor: true }, String(totalTokens), " tokens"),
    h(Text, { dimColor: true }, " │ "),
    h(Text, { dimColor: true }, costStr),
    toolsUsed > 0 ? h(Text, { dimColor: true }, " │ ") : null,
    toolsUsed > 0 ? h(Text, { dimColor: true }, String(toolsUsed), " tools") : null,
  );
}
