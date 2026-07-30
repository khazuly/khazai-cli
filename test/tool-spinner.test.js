import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h } from "react";
import { Box, render, Text } from "ink";
import stringWidth from "string-width";
import { ToolCall } from "../ui/components/tool-call.js";
import {
  TOOL_SPINNER_FRAMES,
  TOOL_SPINNER_INTERVAL_MS,
} from "../ui/components/tool-spinner.js";
import {
  stripAnsi,
  TerminalInput,
  TerminalOutput,
} from "./helpers/ink-render.js";

function activeView(startedAt, Sibling) {
  return h(Box, { flexDirection: "column" },
    h(ToolCall, {
      tool: "bash",
      args: { command: "npm test -- --runInBand" },
      done: false,
      status: "running",
      startedAt,
      toolCallId: "shell-call",
      scopeKey: "run:turn:epoch",
    }),
    h(Sibling),
    h(Text, null, "PROMPT STABLE"),
    h(Text, null, "FOOTER STABLE"),
  );
}

function visibleFrames(stdout) {
  return stdout.frames
    .map(frame => stripAnsi(frame).replace(/\r/g, ""))
    .filter(frame => frame.trim());
}

test("tool spinner frames use one terminal cell and a fixed interval", () => {
  assert.equal(TOOL_SPINNER_INTERVAL_MS, 100);
  assert.ok(TOOL_SPINNER_FRAMES.length > 1);
  assert.ok(TOOL_SPINNER_FRAMES.every(frame => stringWidth(frame) === 1));
});

test("spinner frames keep the active row, prompt, and footer layout stable", async () => {
  const stdout = new TerminalOutput(40, 12);
  const stdin = new TerminalInput();
  let siblingRenders = 0;
  const startedAt = Date.now() - 12_000;
  function StableSibling() {
    siblingRenders++;
    return h(Text, null, "PLAN STABLE");
  }
  const instance = render(activeView(startedAt, StableSibling), {
    stdout,
    stdin,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await new Promise(resolve => setTimeout(resolve, 360));
  const frames = visibleFrames(stdout);
  assert.ok(frames.length >= 3);
  const normalized = frames.slice(-3).map(frame => frame
    .replace(new RegExp(`[${TOOL_SPINNER_FRAMES.join("")}]`, "g"), "S")
    .replace(/· \d+s/g, "· TIME"));
  assert.ok(normalized.every(frame => frame === normalized[0]));
  assert.ok(normalized.every(frame => frame.includes("PROMPT STABLE")));
  assert.ok(normalized.every(frame => frame.includes("FOOTER STABLE")));
  assert.equal(siblingRenders, 1);
  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});

test("settling a tool clears its spinner interval", async () => {
  const stdout = new TerminalOutput(40, 12);
  const stdin = new TerminalInput();
  function StableSibling() {
    return h(Text, null, "PLAN STABLE");
  }
  const running = activeView(Date.now() - 2_000, StableSibling);
  const instance = render(running, {
    stdout,
    stdin,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await new Promise(resolve => setTimeout(resolve, 240));
  instance.rerender(h(ToolCall, {
    tool: "bash",
    args: { command: "npm test -- --runInBand" },
    done: true,
    duration: 2_400,
    content: "Exit: 0\n24 tests passed, 0 failed",
    toolCallId: "shell-call",
    scopeKey: "run:turn:epoch",
  }));
  await new Promise(resolve => setTimeout(resolve, 80));
  const settledWrites = stdout.frames.length;
  await new Promise(resolve => setTimeout(resolve, 3 * TOOL_SPINNER_INTERVAL_MS));
  assert.equal(stdout.frames.length, settledWrites);
  instance.unmount();
  instance.cleanup();
  stdin.destroy();
});
