import assert from "node:assert/strict";
import test from "node:test";
import { bashTool } from "../tools/shell.js";

test("shell guard allows head to limit generated find output", async () => {
  const result = await bashTool.execute({
    command: "find . -maxdepth 1 -type f -name '*' | head -1",
    workdir: process.cwd(),
  });

  assert.match(result, /^Exit: 0/m);
  assert.doesNotMatch(result, /^BLOCKED:/);
});

test("shell guard still blocks head used to inspect a file", async () => {
  const result = await bashTool.execute({
    command: "head -20 package.json",
    workdir: process.cwd(),
  });

  assert.match(result, /^BLOCKED: Use the read tool/);
});

test("shell guard still blocks cat inside a pipeline", async () => {
  const result = await bashTool.execute({
    command: "echo x | cat",
    workdir: process.cwd(),
  });

  assert.match(result, /^BLOCKED: Use the read tool/);
});
