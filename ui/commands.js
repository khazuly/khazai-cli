const MODELS = [
  { name: "big-cock", description: "Big Cock (default)" },
  { name: "auto-free", description: "Auto (free)" },
];

const THEMES = [
  { name: "system", description: "Follow terminal colors (default)" },
  { name: "dark", description: "KhazAI dark theme" },
  { name: "light", description: "Light theme" },
  { name: "mono", description: "Monochrome (no colors)" },
];

export const COMMAND_GROUPS = [
  { id: "session", label: "Session" },
  { id: "workspace", label: "Workspace" },
  { id: "view", label: "View" },
  { id: "settings", label: "Settings" },
];

export const COMMANDS = [
  { name: "/new", description: "Start a persistent session", group: "session" },
  { name: "/sessions", description: "Resume a session in this folder", group: "session" },
  { name: "/continue", description: "Resume the latest folder session", group: "session" },
  { name: "/fork", description: "Fork the current session", group: "session" },
  { name: "/undo", description: "Undo the last compatible turn", group: "session" },
  { name: "/redo", description: "Redo the last undone turn", group: "session" },
  { name: "/compact", description: "Compact session context", group: "session" },
  { name: "/export", description: "Export this session to Markdown", group: "session" },
  { name: "/connect", description: "Connect an OpenAI-compatible provider", group: "workspace" },
  { name: "/agent", description: "Select a primary agent", group: "workspace" },
  { name: "/skills", description: "List available workspace skills", group: "workspace" },
  { name: "/lsp", description: "Show language server status", group: "workspace" },
  { name: "/mcp", description: "Manage MCP servers", group: "workspace" },
  { name: "/model", description: "Change the active model", group: "view", sub: MODELS },
  { name: "/models", description: "Select a configured model", group: "view" },
  { name: "/theme", description: "Change the interface theme", group: "view", sub: THEMES },
  { name: "/reasoning", description: "Set Codex reasoning effort", group: "view" },
  { name: "/details", description: "Toggle tool result details", group: "view" },
  { name: "/expand", description: "Expand the latest tool result", group: "view" },
  { name: "/collapse", description: "Collapse tool details", group: "view" },
  { name: "/auto", description: "Toggle auto-approval", group: "settings" },
  { name: "/help", description: "Show command reference", group: "settings" },
  { name: "/exit", description: "Exit KhazAI", group: "settings" },
];

export function groupedCommands(commands = COMMANDS) {
  return COMMAND_GROUPS.map(group => ({
    ...group,
    commands: commands.filter(command => command.group === group.id),
  })).filter(group => group.commands.length > 0);
}

export function formatCommandHelp(commands = COMMANDS) {
  return groupedCommands(commands).map(group => [
    `**${group.label}**`,
    ...group.commands.map(command => `\`${command.name}\` — ${command.description}`),
  ].join("\n")).join("\n\n");
}

export { MODELS, THEMES };
