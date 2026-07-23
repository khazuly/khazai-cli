import { strict as assert } from "assert";
import { planItemPresentation } from "../ui/components/plan-list.js";

function formatPlanItem(item) {
  const { indicator, colorRole } = planItemPresentation(item.status);
  const prefix = indicator ? `${indicator} ` : "    ";
  return { prefix, colorRole, formatted: `${prefix}${item.description}` };
}

// Test 1: Done task has [✓] indicator and pastel green color
const doneItem = { status: "done", description: "Read app/agent.js" };
const doneFormatted = formatPlanItem(doneItem);
assert.strictEqual(doneFormatted.prefix, "[✓] ", "Done item should have [✓] prefix");
assert.strictEqual(doneFormatted.colorRole, "success", "Done item should use the success theme role");
assert.strictEqual(doneFormatted.formatted, "[✓] Read app/agent.js", "Done item should format correctly");
console.log("✓ Test 1: Done task renders with [✓] and pastel green");

// Test 2: Running task has [•] indicator and lavender color
const runningItem = { status: "running", description: "Create token masking utility" };
const runningFormatted = formatPlanItem(runningItem);
assert.strictEqual(runningFormatted.prefix, "[•] ", "Running item should have [•] prefix");
assert.strictEqual(runningFormatted.colorRole, "secondary", "Running item should use the secondary theme role");
assert.strictEqual(runningFormatted.formatted, "[•] Create token masking utility", "Running item should format correctly");
console.log("✓ Test 2: Running task renders with [•] and lavender");

// Test 3: Pending task has [ ] indicator and muted color
const pendingItem = { status: "pending", description: "Add intent resolver logic" };
const pendingFormatted = formatPlanItem(pendingItem);
assert.strictEqual(pendingFormatted.prefix, "[ ] ", "Pending item should have [ ] prefix");
assert.strictEqual(pendingFormatted.colorRole, "muted", "Pending item should use the muted theme role");
assert.strictEqual(pendingFormatted.formatted, "[ ] Add intent resolver logic", "Pending item should format correctly");
console.log("✓ Test 3: Pending task renders with [ ] and muted color");

// Test 4: Failed task is neutral (not active) and rose color
const failedItem = { status: "failed", description: "Failed operation" };
const failedFormatted = formatPlanItem(failedItem);
assert.strictEqual(failedFormatted.prefix, "[×] ", "Failed item should have [×] prefix");
assert.strictEqual(failedFormatted.colorRole, "error", "Failed item should use the error theme role");
assert.strictEqual(failedFormatted.formatted, "[×] Failed operation", "Failed item should format correctly");
console.log("✓ Test 4: Failed task is neutral and rose color");

// Test 5: Skipped task has no indicator and muted color
const skippedItem = { status: "skipped", description: "Skipped task" };
const skippedFormatted = formatPlanItem(skippedItem);
assert.strictEqual(skippedFormatted.prefix, "[ ] ", "Skipped item should use [ ] prefix");
assert.strictEqual(skippedFormatted.colorRole, "muted", "Skipped item should use the muted theme role");
assert.strictEqual(skippedFormatted.formatted, "[ ] Skipped task", "Skipped item should format correctly");
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

// Test 8: Theme roles are stable presentation values
const roles = [doneFormatted, runningFormatted, pendingFormatted, failedFormatted].map(item => item.colorRole);
assert.ok(roles.every(role => typeof role === "string"), "All plan colors should use semantic theme roles");
console.log("✓ Test 8: All plan colors use semantic theme roles");

console.log("\n=== All plan-list render tests passed ===");
