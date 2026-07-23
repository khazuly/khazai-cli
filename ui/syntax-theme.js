const BASE = {
  text: "#d4d4d4",
  muted: "#858585",
  comment: "#6a9955",
  keyword: "#c586c0",
  type: "#4ec9b0",
  function: "#dcdcaa",
  string: "#ce9178",
  number: "#b5cea8",
  property: "#9cdcfe",
  operator: "#d4d4d4",
  tag: "#569cd6",
  added: "#6a9955",
  addedBackground: "#173b2a",
  deleted: "#f14c4c",
  deletedBackground: "#45232b",
  hunk: "#4fc1ff",
};

export const SYNTAX_THEMES = [
  ["catppuccin-frappe", "Catppuccin Frappe", { text: "#c6d0f5", muted: "#737994", comment: "#838ba7", keyword: "#ca9ee6", type: "#e5c890", function: "#8caaee", string: "#a6d189", number: "#ef9f76", property: "#99d1db" }],
  ["catppuccin-latte", "Catppuccin Latte", { text: "#4c4f69", muted: "#9ca0b0", comment: "#8c8fa1", keyword: "#8839ef", type: "#df8e1d", function: "#1e66f5", string: "#40a02b", number: "#fe640b", property: "#179299", addedBackground: "#d8f3dc", deletedBackground: "#f8d7da" }],
  ["catppuccin-macchiato", "Catppuccin Macchiato", { text: "#cad3f5", muted: "#6e738d", comment: "#8087a2", keyword: "#c6a0f6", type: "#eed49f", function: "#8aadf4", string: "#a6da95", number: "#f5a97f", property: "#8bd5ca" }],
  ["catppuccin-mocha", "Catppuccin Mocha", { text: "#cdd6f4", muted: "#6c7086", comment: "#7f849c", keyword: "#cba6f7", type: "#f9e2af", function: "#89b4fa", string: "#a6e3a1", number: "#fab387", property: "#89dceb" }],
  ["dracula", "Dracula", { text: "#f8f8f2", muted: "#6272a4", comment: "#6272a4", keyword: "#ff79c6", type: "#8be9fd", function: "#50fa7b", string: "#f1fa8c", number: "#bd93f9", property: "#8be9fd", addedBackground: "#23452f", deletedBackground: "#4a2633" }],
  ["monokai-extended-bright", "Monokai Extended Bright", { text: "#f8f8f2", muted: "#75715e", comment: "#75715e", keyword: "#f92672", type: "#66d9ef", function: "#a6e22e", string: "#e6db74", number: "#ae81ff", property: "#a6e22e" }],
  ["monokai-extended-light", "Monokai Extended Light", { text: "#272822", muted: "#8f908a", comment: "#75715e", keyword: "#f92672", type: "#66d9ef", function: "#a6e22e", string: "#e6db74", number: "#ae81ff", property: "#66d9ef", addedBackground: "#dff0d8", deletedBackground: "#f2dede" }],
  ["solarized-dark", "Solarized (dark)", { text: "#839496", muted: "#586e75", comment: "#586e75", keyword: "#859900", type: "#b58900", function: "#268bd2", string: "#2aa198", number: "#d33682", property: "#268bd2" }],
  ["solarized-light", "Solarized (light)", { text: "#657b83", muted: "#93a1a1", comment: "#93a1a1", keyword: "#859900", type: "#b58900", function: "#268bd2", string: "#2aa198", number: "#d33682", property: "#268bd2", addedBackground: "#e5f1d7", deletedBackground: "#f8dddd" }],
  ["sublime-snazzy", "Sublime Snazzy", { text: "#eff0eb", muted: "#78787e", comment: "#78787e", keyword: "#ff5c57", type: "#57c7ff", function: "#ff6ac1", string: "#5af78e", number: "#ff9f43", property: "#9aedfe" }],
  ["two-dark", "TwoDark", { text: "#abb2bf", muted: "#5c6370", comment: "#5c6370", keyword: "#c678dd", type: "#e5c07b", function: "#61afef", string: "#98c379", number: "#d19a66", property: "#56b6c2" }],
];

const PALETTES = new Map(SYNTAX_THEMES.map(([id, _label, colors]) => [id, { ...BASE, ...colors }]));
const LEGACY = { system: "catppuccin-mocha", dark: "catppuccin-mocha", light: "catppuccin-latte", mono: "catppuccin-mocha" };

export function normalizeSyntaxTheme(value) {
  const theme = String(value || "").toLowerCase();
  return PALETTES.has(theme) ? theme : LEGACY[theme] || "catppuccin-mocha";
}

export function isSyntaxTheme(value) {
  return PALETTES.has(String(value || "").toLowerCase());
}

export function syntaxThemeColors(value) {
  return PALETTES.get(normalizeSyntaxTheme(value));
}
