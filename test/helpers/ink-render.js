import { Readable, Writable } from "node:stream";
import { render } from "ink";

export class TerminalOutput extends Writable {
  constructor(columns, rows) {
    super();
    this.columns = columns;
    this.rows = rows;
    this.isTTY = true;
    this.frames = [];
  }
  _write(chunk, _encoding, callback) {
    this.frames.push(String(chunk));
    callback();
  }
  getColorDepth() { return 24; }
  hasColors() { return true; }
}

export class TerminalInput extends Readable {
  constructor() {
    super();
    this.isTTY = true;
    this.isRaw = false;
  }
  _read() {}
  setRawMode(value) { this.isRaw = value; }
  ref() {}
  unref() {}
}

export function stripAnsi(text) {
  return text
    .replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "")
    .replace(/[\u200b\u2800]/g, match => match === "\u2800" ? " " : "");
}

export async function renderComponent(component, columns = 40, rows = 24) {
  const stdout = new TerminalOutput(columns, rows);
  const stdin = new TerminalInput();
  const instance = render(component, {
    stdout,
    stdin,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await new Promise(resolve => setTimeout(resolve, 40));
  const frames = stdout.frames.map(frame => stripAnsi(frame).replace(/\r/g, "")).filter(frame => frame.trim());
  const frame = frames.sort((left, right) => right.length - left.length)[0] || "";
  instance.unmount();
  instance.cleanup();
  stdin.destroy();
  return frame;
}

export function maximumBlankRun(text) {
  let current = 0;
  let maximum = 0;
  for (const line of text.split("\n")) {
    current = line.trim() ? 0 : current + 1;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}
