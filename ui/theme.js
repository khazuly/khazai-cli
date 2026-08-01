import { createContext, createElement as h, useContext } from "react";
import { SYNTAX_PALETTES } from "./theme-palette.js";
import { THEMES, THEME_DESCRIPTIONS } from "./theme-definitions.js";

export const THEME_NAMES = Object.keys(THEMES);


export function isKnownTheme(value) {
  const key = String(value || "").toLowerCase();
  return THEME_NAMES.includes(key) ? key : null;
}

export function resolveTheme(name = "system", environment = process.env) {
  const requested = String(name || "").toLowerCase();
  if (environment.NO_COLOR !== undefined) {
    return { ...THEMES.mono, name: "mono" };
  }
  return THEMES[requested] || THEMES.system;
}

const ThemeContext = createContext(resolveTheme());

export function ThemeProvider({ name, children }) {
  return h(ThemeContext.Provider, { value: resolveTheme(name, process.env) }, children);
}

export function useTheme() {
  return useContext(ThemeContext);
}


export { THEMES, THEME_DESCRIPTIONS, SYNTAX_PALETTES };
