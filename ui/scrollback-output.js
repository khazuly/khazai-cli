export const CLEAR_TERMINAL = "\u001b[2J\u001b[3J\u001b[H";

export const NORMAL_SCROLL_MODE = [
  "\u001b[?1049l", // leave alternate screen after a previous crash
  "\u001b[?1000l", // disable basic mouse tracking
  "\u001b[?1002l", // disable button-event mouse tracking
  "\u001b[?1003l", // disable all-event mouse tracking
  "\u001b[?1006l", // disable SGR mouse tracking
].join("");

export function prepareScrollableTerminal(stdout) {
  if (!stdout?.isTTY || typeof stdout.write !== "function") return false;
  stdout.write(NORMAL_SCROLL_MODE + CLEAR_TERMINAL);
  return true;
}
