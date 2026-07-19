import { createContext, createElement as h, useContext } from "react";

const THEMES = {
  dark: {
    name: "dark",
    colorEnabled: true,
    background: "#1e1e2e",
    panel: "#181825",
    text: "#cdd6f4",
    assistant: "#cdd6f4",
    toolResult: "#a6adc8",
    toolTarget: "#89b4fa",
    metadata: "#6c7086",
    muted: "#585b70",
    border: "#45475a",
    primary: "#89b4fa",
    secondary: "#cba6f7",
    info: "#74c7ec",
    success: "#a6e3a1",
    warning: "#f9e2af",
    error: "#f38ba8",
    inputText: "#cdd6f4",
    codeBackground: "#181825",
  },
  light: {
    name: "light",
    colorEnabled: true,
    background: "#eff1f5",
    panel: "#e6e9ef",
    text: "#4c4f69",
    assistant: "#4c4f69",
    toolResult: "#5c5f77",
    toolTarget: "#1e66f5",
    metadata: "#9ca0b0",
    muted: "#acb0be",
    border: "#ccd0da",
    primary: "#1e66f5",
    secondary: "#8839ef",
    info: "#04a5e5",
    success: "#40a02b",
    warning: "#df8e1d",
    error: "#d20f39",
    inputText: "#4c4f69",
    codeBackground: "#e6e9ef",
  },
  system: {
    name: "system",
    colorEnabled: true,
    background: undefined,
    panel: undefined,
    text: undefined,
    assistant: undefined,
    toolResult: "#a6adc8",
    toolTarget: "#89b4fa",
    metadata: "#6c7086",
    muted: "#585b70",
    border: "#45475a",
    primary: "#89b4fa",
    secondary: "#cba6f7",
    info: "#74c7ec",
    success: "#a6e3a1",
    warning: "#f9e2af",
    error: "#f38ba8",
    inputText: undefined,
    codeBackground: undefined,
  },
  mono: {
    name: "mono",
    colorEnabled: false,
    background: undefined,
    panel: undefined,
    text: undefined,
    assistant: undefined,
    toolResult: undefined,
    toolTarget: undefined,
    metadata: undefined,
    muted: undefined,
    border: undefined,
    primary: undefined,
    secondary: undefined,
    info: undefined,
    success: undefined,
    warning: undefined,
    error: undefined,
    inputText: undefined,
    codeBackground: undefined,
  },
};

export function resolveTheme(name = "system", environment = process.env) {
  if (environment.NO_COLOR !== undefined) return THEMES.mono;
  return THEMES[String(name || "").toLowerCase()] || THEMES.system;
}

const ThemeContext = createContext(THEMES.system);

export function ThemeProvider({ name, children }) {
  return h(ThemeContext.Provider, { value: resolveTheme(name) }, children);
}

export function useTheme() {
  return useContext(ThemeContext);
}

export { THEMES };
