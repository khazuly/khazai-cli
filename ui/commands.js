const MODELS = [
  { name: "gpt", description: "openai/gpt-4o-mini" },
  { name: "claude", description: "anthropic/claude-haiku-4-5" },
  { name: "gemini", description: "google/gemini-2.0-flash-001" },
  { name: "deepseek", description: "deepseek/deepseek-chat-v3-0324" },
  { name: "grok", description: "x-ai/grok-3-mini-beta" },
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
  { name: "/help", description: "Show available commands" },
];

export { MODELS, THEMES };
