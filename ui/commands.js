import { THEME_NAMES, THEME_DESCRIPTIONS } from "./theme.js";
import { zenModels } from "../config/khazai-free-models.js";

const MODELS = [
  ...zenModels().filter(model => model.upstreamModel).map(model => ({
    name: model.key,
    description: model.alias === "big-cock" ? "Big Cock (default)" : model.description,
  })),
  { name: "auto-free", description: "Auto (free)" },
];

const THEMES = THEME_NAMES.map(name => ({ name, description: THEME_DESCRIPTIONS[name] || name }));
const MCP_COMMANDS = [
  { name: "list", description: "List configured MCP servers" },
  { name: "add", description: "Add an MCP server" },
  { name: "remove", description: "Remove an MCP server" },
  { name: "status", description: "Show MCP server status" },
  { name: "connect", description: "Connect an MCP server" },
  { name: "disconnect", description: "Disconnect an MCP server" },
  { name: "enable", description: "Enable automatic connection" },
  { name: "disable", description: "Disable automatic connection" },
  { name: "tools", description: "List discovered MCP tools" },
  { name: "resources", description: "List MCP resources" },
  { name: "prompts", description: "List MCP prompts" },
  { name: "reload", description: "Reload MCP configuration" },
];

export const COMMAND_CATEGORIES = [
  { id: "core", label: "Core" },
  { id: "execution", label: "Execution" },
  { id: "workspace", label: "Workspace" },
  { id: "help", label: "Help" },
];


export const COMMAND_GROUPS = [
  { id: "session", label: "Session" },
  { id: "workspace", label: "Workspace" },
  { id: "view", label: "View" },
  { id: "settings", label: "Settings" },
];















export const COMMANDS = [

  { name: "/new", description: "Start a new session", category: "core", aliases: [], visible: true, group: "session" },
  { name: "/sessions", description: "Resume or manage sessions", category: "core", aliases: [], visible: true, group: "session", sub: [
    { name: "list", description: "List saved sessions in this folder" },
    { name: "resume", description: "Resume a session by ID" },
    { name: "delete", description: "Delete a session by ID" },
    { name: "clear", description: "Delete all saved sessions in this folder" },
  ] },
  { name: "/continue", description: "Resume the latest session", category: "core", aliases: [], visible: false, group: "session" },
  { name: "/fork", description: "Fork the current session", category: "core", aliases: [], visible: false, group: "session" },
  { name: "/undo", description: "Undo the last compatible turn", category: "core", aliases: [], visible: false, group: "session" },
  { name: "/redo", description: "Redo the last undone turn", category: "core", aliases: [], visible: false, group: "session" },
  { name: "/compact", description: "Compact session context", category: "workspace", aliases: [], visible: false, group: "session" },
  { name: "/retry", description: "Retry the latest failed model continuation", category: "core", aliases: [], visible: false, group: "session" },
  { name: "/queue", description: "Show or clear queued messages", category: "core", aliases: [], visible: false, group: "session" },
  { name: "/export", description: "Export session to Markdown", category: "workspace", aliases: [], visible: false, group: "session" },
  { name: "/model", description: "Select the active model", category: "core", aliases: ["/models"], visible: true, group: "view", sub: [
    ...MODELS,
    { name: "list", description: "List all available models" },
    { name: "free", description: "List all KhazAI free models" },
    { name: "refresh", description: "Refresh model availability" },
    { name: "details", description: "Show details for a KhazAI free model" },
  ] },
  { name: "/agent", description: "Change agent mode", category: "core", aliases: [], visible: true, group: "workspace" },
  { name: "/setting", description: "Configure model behavior", category: "core", aliases: [], visible: true, group: "view", sub: [
    { name: "show", description: "Display effective settings for the active model" },
    { name: "model", description: "Open model-specific settings" },
    { name: "reset", description: "Reset all settings to provider defaults" },
  ] },
  { name: "/usage", description: "Show context and session token usage", category: "core", aliases: [], visible: true, group: "view" },
  { name: "/theme", description: "Change the interface theme", category: "core", aliases: [], visible: true, group: "view", openSubmenu: true, sub: THEMES },
  { name: "/mcp", description: "Manage MCP servers", category: "core", aliases: [], visible: true, group: "workspace", sub: MCP_COMMANDS },
  { name: "/connect", description: "Connect a provider", category: "workspace", aliases: [], visible: false, group: "workspace" },
  { name: "/skills", description: "List workspace skills", category: "workspace", aliases: [], visible: false, group: "workspace" },
  { name: "/lsp", description: "Show language server status", category: "workspace", aliases: [], visible: false, group: "workspace" },
  { name: "/reasoning", description: "Set Codex reasoning effort", category: "core", aliases: [], visible: false, group: "view" },


  { name: "/cancel", description: "Cancel the active run", category: "execution", aliases: [], visible: true, available: "submitting", group: "session" },
  { name: "/allow-all", description: "Toggle automatic permission approval for this workspace", category: "execution", aliases: ["/auto"], visible: true, group: "settings", sub: [
    { name: "status", description: "Show whether allow-all is enabled" },
    { name: "off", description: "Disable allow-all while preserving individual rules" },
  ] },
  { name: "/permissions", description: "Manage workspace permissions", category: "execution", aliases: [], visible: true, group: "settings", sub: [
    { name: "list", description: "Show active rules for the current workspace" },
    { name: "revoke", description: "Revoke one permission rule by id" },
    { name: "reset", description: "Remove all persisted permissions for the current workspace" },
  ] },
  { name: "/details", description: "Toggle tool result details", category: "execution", aliases: ["/expand", "/collapse"], visible: true, available: "tools", group: "view", sub: [
    { name: "on", description: "Expand the latest tool result" },
    { name: "off", description: "Collapse tool details" },
    { name: "toggle", description: "Toggle the latest tool result" },
  ] },


  { name: "/init", description: "Create AGENTS.md using the active model", category: "workspace", aliases: ["/ini"], visible: true, group: "settings" },
  { name: "/help", description: "Show command reference", category: "help", aliases: [], visible: true, group: "settings" },
  { name: "/exit", description: "Exit KhazAI", category: "help", aliases: ["/quit"], visible: true, group: "settings" },
];





export function resolveAlias(input) {
  const cmd = canonicalCommand(input);
  return cmd || null;
}




export function canonicalCommand(name) {

  const direct = COMMANDS.find(c => c.name === name);
  if (direct) return direct;

  return COMMANDS.find(c => c.aliases.includes(name));
}







export function visibleCommands(context = {}) {
  return COMMANDS.filter(c => {
    if (!c.visible) return false;
    if (c.available === "submitting" && !context.submitting) return false;
    if (c.available === "tools" && !context.hasTools) return false;
    return true;
  });
}




export function groupedCommands(commands = COMMANDS) {
  return COMMAND_GROUPS.map(group => ({
    ...group,
    commands: commands.filter(command => command.group === group.id),
  })).filter(group => group.commands.length > 0);
}




export function groupedVisibleCommands(context = {}) {
  const visible = visibleCommands(context);
  return COMMAND_CATEGORIES.map(cat => ({
    ...cat,
    commands: visible.filter(c => c.category === cat.id),
  })).filter(g => g.commands.length > 0);
}

export function formatCommandHelp(commands = visibleCommands()) {
  return groupedCommands(commands).map(group => [
    `**${group.label}**`,
    ...group.commands.map(command => `\`${command.name}\` — ${command.description}`),
  ].join("\n")).join("\n\n");
}





const ALIAS_ACTIONS = {
  "/expand": { command: "/details", arg: "on" },
  "/collapse": { command: "/details", arg: "off" },
};





export function resolveCommand(input) {
  const action = ALIAS_ACTIONS[input];
  if (action) return action;
  const canonical = canonicalCommand(input);
  if (canonical) return { command: canonical.name, arg: "" };
  return { command: input, arg: "" };
}

export { MODELS, THEMES };
