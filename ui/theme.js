import { createContext, createElement as h, useContext } from "react";

const THEMES = {
  dark: {
    name: "dark",
    colorEnabled: true,
    background: "#0d1117",
    panel: "#0f0f10",
    text: "#c2c7cf",
    assistant: "#c9d1d9",
    toolResult: "#929ba6",
    toolTarget: "#9eb3c8",
    metadata: "#707985",
    muted: "#8b949e",
    border: "#59636e",
    primary: "#b18496",
    secondary: "#9a86b8",
    info: "#7897b0",
    success: "#88a295",
    warning: "#a98b68",
    error: "#b87578",
    inputText: "#e6edf3",
    codeBackground: "#0d1117",
  },
  light: {
    name: "light",
    colorEnabled: true,
    background: "#ffffff",
    panel: "#eef1f4",
    text: "#30363d",
    assistant: "#24292f",
    toolResult: "#57606a",
    toolTarget: "#445f78",
    metadata: "#6e7781",
    muted: "#6e7781",
    border: "#afb8c1",
    primary: "#82536c",
    secondary: "#65558f",
    info: "#315f82",
    success: "#347d55",
    warning: "#8a5d20",
    error: "#a73a3a",
    inputText: "#24292f",
    codeBackground: "#f6f8fa",
  },
  system: {
    name: "system",
    colorEnabled: true,
    background: undefined,
    panel: undefined,
    text: undefined,
    assistant: undefined,
    toolResult: "#929ba6",
    toolTarget: "#9eb3c8",
    metadata: "#707985",
    muted: "#8b949e",
    border: "#87909a",
    primary: "#b18496",
    secondary: "#9a86b8",
    info: "#7897b0",
    success: "#88a295",
    warning: "#a98b68",
    error: "#b87578",
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
