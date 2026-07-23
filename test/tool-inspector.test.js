import assert from "node:assert/strict";
import test from "node:test";
import { Readable, Writable } from "node:stream";
import { createElement as h } from "react";
import { render } from "ink";
import { ToolDetailInspector } from "../ui/components/tool-detail-inspector.js";
import { ThemeProvider } from "../ui/theme.js";

class TerminalOutput extends Writable {
  constructor(columns = 50, rows = 18) {
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

class TerminalInput extends Readable {
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

function stripAnsi(text) {
  return text
    .replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "")
    .replace(/\u200b/g, "")
    .replace(/\r/g, "");
}

function longestFrame(stdout) {
  return stdout.frames
    .map(stripAnsi)
    .filter(frame => frame.trim())
    .sort((left, right) => right.length - left.length)[0] || "";
}

function inspectorMessage(overrides = {}) {
  return {
    id: "tool-detail",
    callId: "call-detail",
    type: "tool",
    tool: "bash",
    args: { command: "npm test" },
    done: true,
    duration: 618,
    resultSize: 256,
    content: "Exit: 0\nsuite one\nsuite two",
    ...overrides,
  };
}

test("tool inspector renders bounded structured details and controls", async () => {
  const stdout = new TerminalOutput(50, 18);
  const stdin = new TerminalInput();
  const instance = render(h(ThemeProvider, { name: "dark" },
    h(ToolDetailInspector, { message: inspectorMessage(), onClose() {} }),
  ), { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false });
  await new Promise(resolve => setTimeout(resolve, 60));
  const frame = longestFrame(stdout);

  assert.match(frame, /(?:✓|\[ok\]) Shell\s+npm test/);
  assert.match(frame, /completed · exit 0 · 256 B · 618 ms/);
  assert.match(frame, /Command/);
  assert.match(frame, /Output/);
  assert.match(frame, /suite two/);
  assert.match(frame.replace(/\n│?\s*/g, " "), /PgUp\/PgDn page · Esc close/);
  for (const line of frame.split("\n")) {
    assert.ok(line.length <= 50, `inspector row exceeds viewport: ${line}`);
  }

  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});

test("tool inspector scrolls long output and closes with Escape", async () => {
  const stdout = new TerminalOutput(48, 14);
  const stdin = new TerminalInput();
  let closed = false;
  const content = `Exit: 0\n${Array.from({ length: 20 }, (_, index) => `result ${index + 1}`).join("\n")}`;
  const instance = render(h(ToolDetailInspector, {
    message: inspectorMessage({ content }),
    onClose: () => { closed = true; },
  }), { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false });
  await new Promise(resolve => setTimeout(resolve, 50));
  stdin.push("\u001b[6~");
  await new Promise(resolve => setTimeout(resolve, 50));
  const frame = longestFrame(stdout);
  assert.match(frame, /of 24/);

  stdin.push("\u001b");
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(closed, true);

  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});

test("monochrome inspector uses text status markers", async () => {
  const stdout = new TerminalOutput();
  const stdin = new TerminalInput();
  const instance = render(h(ThemeProvider, { name: "mono" },
    h(ToolDetailInspector, { message: inspectorMessage(), onClose() {} }),
  ), { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.match(longestFrame(stdout), /\[ok\] Shell/);

  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});
