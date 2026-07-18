import { strict as assert } from "assert";
import { planItemPresentation } from "../ui/components/plan-list.js";
import { PASTEL as UI_PASTEL } from "../ui/palette.js";

// Minimal test for plan-list component indicator rendering
// Tests that status indicators, colors, and text alignment work correctly

const PASTEL_GREEN = UI_PASTEL.green;
const PASTEL = {
  lavender: "#9a86b8",
  rose: "#b87578",
  muted: "#8b949e",
};

function formatPlanItem(item) {
  const { indicator, color: textColor } = planItemPresentation(item.status);
  const prefix = indicator ? `${indicator} ` : "    ";
  return { prefix, textColor, formatted: `${prefix}${item.description}` };
}

// Test 1: Done task has [✓] indicator and pastel green color
const doneItem = { status: "done", description: "Read app/agent.js" };
const doneFormatted = formatPlanItem(doneItem);
assert.strictEqual(doneFormatted.prefix, "[✓] ", "Done item should have [✓] prefix");
assert.strictEqual(doneFormatted.textColor, PASTEL_GREEN, "Done item should use pastel green color");
assert.strictEqual(doneFormatted.formatted, "[✓] Read app/agent.js", "Done item should format correctly");
console.log("✓ Test 1: Done task renders with [✓] and pastel green");

// Test 2: Running task has [•] indicator and lavender color
const runningItem = { status: "running", description: "Create token masking utility" };
const runningFormatted = formatPlanItem(runningItem);
assert.strictEqual(runningFormatted.prefix, "[•] ", "Running item should have [•] prefix");
assert.strictEqual(runningFormatted.textColor, PASTEL.lavender, "Running item should use lavender color");
assert.strictEqual(runningFormatted.formatted, "[•] Create token masking utility", "Running item should format correctly");
console.log("✓ Test 2: Running task renders with [•] and lavender");

// Test 3: Pending task has no indicator (two spaces) and muted color
const pendingItem = { status: "pending", description: "Add intent resolver logic" };
const pendingFormatted = formatPlanItem(pendingItem);
assert.strictEqual(pendingFormatted.prefix, "    ", "Pending item should reserve indicator alignment");
assert.strictEqual(pendingFormatted.textColor, PASTEL.muted, "Pending item should use muted color");
assert.strictEqual(pendingFormatted.formatted, "    Add intent resolver logic", "Pending item should format correctly");
console.log("✓ Test 3: Pending task renders with no indicator and muted color");

// Test 4: Failed task is neutral (not active) and rose color
const failedItem = { status: "failed", description: "Failed operation" };
const failedFormatted = formatPlanItem(failedItem);
assert.strictEqual(failedFormatted.prefix, "    ", "Failed item should not appear active");
assert.strictEqual(failedFormatted.textColor, PASTEL.rose, "Failed item should use rose color");
assert.strictEqual(failedFormatted.formatted, "    Failed operation", "Failed item should format correctly");
console.log("✓ Test 4: Failed task is neutral and rose color");

// Test 5: Skipped task has no indicator and muted color
const skippedItem = { status: "skipped", description: "Skipped task" };
const skippedFormatted = formatPlanItem(skippedItem);
assert.strictEqual(skippedFormatted.prefix, "    ", "Skipped item should reserve indicator alignment");
assert.strictEqual(skippedFormatted.textColor, PASTEL.muted, "Skipped item should use muted color");
assert.strictEqual(skippedFormatted.formatted, "    Skipped task", "Skipped item should format correctly");
console.log("✓ Test 5: Skipped task renders with no indicator and muted color");

// Test 6: Alignment check - all indicators/prefixes have consistent width
const items = [
  { status: "done", description: "Task 1" },
  { status: "running", description: "Task 2" },
  { status: "pending", description: "Task 3" },
  { status: "failed", description: "Task 4" },
  { status: "skipped", description: "Task 5" },
];
const formatted = items.map(formatPlanItem);
const prefixLengths = formatted.map(f => f.prefix.length);
const uniqueLengths = new Set(prefixLengths);
assert.equal(uniqueLengths.size, 1, "All prefixes should reserve the same width");
console.log("✓ Test 6: All items have consistent prefix alignment");

// Test 7: No old labels (done, now, next) in output
const allFormatted = formatted.map(f => f.formatted).join("\n");
assert.ok(!allFormatted.includes("done"), "Output should not contain 'done' label");
assert.ok(!allFormatted.includes("now"), "Output should not contain 'now' label");
assert.ok(!allFormatted.includes("next"), "Output should not contain 'next' label");
assert.ok(!allFormatted.includes("failed"), "Output should not contain 'failed' label");
assert.ok(!allFormatted.includes("skip"), "Output should not contain 'skip' label");
console.log("✓ Test 7: No old labels (done/now/next/failed/skip) in formatted output");

// Test 8: Color values are valid hex colors
const colors = [PASTEL_GREEN, PASTEL.lavender, PASTEL.muted, PASTEL.rose];
const hexColorPattern = /^#[0-9a-f]{6}$/i;
assert.ok(colors.every(c => hexColorPattern.test(c)), "All colors should be valid hex format");
console.log("✓ Test 8: All color values are valid hex colors");

console.log("\n=== All plan-list render tests passed ===");
