import assert from "node:assert/strict";
import test from "node:test";
import { insertText, printableText } from "../ui/components/prompt-input-utils.js";

test("prompt printable text preserves uppercase characters", () => {
  assert.equal(printableText("ABC Def"), "ABC Def");
  assert.deepEqual(insertText({ value: "ask ", cursor: 4 }, printableText("Claude")), { value: "ask Claude", cursor: 10 });
});
