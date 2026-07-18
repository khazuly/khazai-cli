// Ink clears the terminal and its scrollback (ESC[3J) whenever dynamic output
// reaches stdout.rows. The root layout only depends on terminal width, so a
// virtual row count safely keeps Ink on its normal line-update path while the
// real terminal continues accumulating completed <Static> messages.
const VIRTUAL_SCROLLBACK_ROWS = 1_000_000;

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

export function createScrollbackOutput(stdout) {
  return new Proxy(stdout, {
    get(target, property) {
      if (property === "rows") return VIRTUAL_SCROLLBACK_ROWS;
      if (property === "actualRows") return Math.max(1, Number(target.rows) || 24);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
