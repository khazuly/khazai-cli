const MODELS = [
  { name: "big-cock", description: "Big Cock (default)" },
];

const THEMES = [
  { name: "system", description: "Follow terminal colors (default)" },
  { name: "dark", description: "KhazAI dark theme" },
  { name: "light", description: "Light theme" },
  { name: "mono", description: "Monochrome (no colors)" },
];

export const COMMANDS = [
  { name: "/exit", description: "Exit application" },
  { name: "/model", description: "Show AI model", sub: MODELS },
  { name: "/models", description: "Select a configured provider model" },
  { name: "/connect", description: "Connect an OpenAI-compatible provider" },
  { name: "/new", description: "Start a new persistent session" },
  { name: "/sessions", description: "List and resume sessions" },
  { name: "/continue", description: "Resume a previous session" },
  { name: "/fork", description: "Fork the current session" },
  { name: "/undo", description: "Undo the last turn and compatible file changes" },
  { name: "/redo", description: "Redo the last undone turn" },
  { name: "/compact", description: "Compact agent context" },
  { name: "/export", description: "Export the current session to Markdown" },
  { name: "/details", description: "Toggle expanded tool details" },
  { name: "/auto", description: "Toggle auto-approval for ask permissions" },
  { name: "/agent", description: "Select a primary agent profile" },
  { name: "/skills", description: "List discovered reusable skills" },
  { name: "/lsp", description: "Show language server status" },
  { name: "/mcp", description: "List, refresh, or authenticate MCP servers" },
  { name: "/theme", description: "Change color theme", sub: THEMES },
  { name: "/expand", description: "Expand the latest tool result" },
  { name: "/collapse", description: "Collapse the latest tool result" },
  { name: "/help", description: "Show available commands" },
];

export { MODELS, THEMES };
