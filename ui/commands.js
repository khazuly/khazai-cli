const MODELS = [
  { name: "gpt", description: "openai/gpt-4o-mini" },
  { name: "claude", description: "anthropic/claude-haiku-4-5" },
  { name: "qwen", description: "qwen/qwen-2.5-72b-instruct" },
];

const THEMES = [
  { name: "dark", description: "Dark theme (default)" },
  { name: "light", description: "Light theme" },
  { name: "mono", description: "Monochrome (no colors)" },
];

export const COMMANDS = [
  { name: "/exit", description: "Exit application" },
  { name: "/model", description: "Switch AI model", sub: MODELS },
  { name: "/theme", description: "Change color theme", sub: THEMES },
  { name: "/expand", description: "Expand the latest tool result" },
  { name: "/collapse", description: "Collapse the latest tool result" },
  { name: "/help", description: "Show available commands" },
];

export { MODELS, THEMES };
