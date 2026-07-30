export const CLEAR_TERMINAL = "\u001b[2J\u001b[3J\u001b[H";

export const NORMAL_SCROLL_MODE = [
  "\u001b[?1049l",
  "\u001b[?1000l",
  "\u001b[?1002l",
  "\u001b[?1003l",
  "\u001b[?1006l",
].join("");

export function prepareScrollableTerminal(stdout) {
  if (!stdout?.isTTY || typeof stdout.write !== "function") return false;
  stdout.write(NORMAL_SCROLL_MODE + CLEAR_TERMINAL);
  return true;
}
