import { strict as assert } from "assert";
import { completedPlanCount, planItemKey, planItemPresentation } from "../ui/components/plan-list.js";

function formatPlanItem(item) {
  const { indicator, colorRole } = planItemPresentation(item.status);
  const prefix = indicator ? `${indicator} ` : "    ";
  return { prefix, colorRole, formatted: `${prefix}${item.description}` };
}


const doneItem = { status: "done", description: "Read app/agent.js" };
const doneFormatted = formatPlanItem(doneItem);
assert.strictEqual(doneFormatted.prefix, "[✓] ", "Done item should have [✓] prefix");
assert.strictEqual(doneFormatted.colorRole, "success", "Done item should use the success theme role");
assert.strictEqual(doneFormatted.formatted, "[✓] Read app/agent.js", "Done item should format correctly");


const runningItem = { status: "running", description: "Create token masking utility" };
const runningFormatted = formatPlanItem(runningItem);
assert.strictEqual(runningFormatted.prefix, "[•] ", "Running item should have [•] prefix");
assert.strictEqual(runningFormatted.colorRole, "secondary", "Running item should use the secondary theme role");
assert.strictEqual(runningFormatted.formatted, "[•] Create token masking utility", "Running item should format correctly");


const pendingItem = { status: "pending", description: "Add intent resolver logic" };
const pendingFormatted = formatPlanItem(pendingItem);
assert.strictEqual(pendingFormatted.prefix, "[ ] ", "Pending item should have [ ] prefix");
assert.strictEqual(pendingFormatted.colorRole, "muted", "Pending item should use the muted theme role");
assert.strictEqual(pendingFormatted.formatted, "[ ] Add intent resolver logic", "Pending item should format correctly");


const failedItem = { status: "failed", description: "Failed operation" };
const failedFormatted = formatPlanItem(failedItem);
assert.strictEqual(failedFormatted.prefix, "[×] ", "Failed item should have [×] prefix");
assert.strictEqual(failedFormatted.colorRole, "error", "Failed item should use the error theme role");
assert.strictEqual(failedFormatted.formatted, "[×] Failed operation", "Failed item should format correctly");


const skippedItem = { status: "skipped", description: "Skipped task" };
const skippedFormatted = formatPlanItem(skippedItem);
assert.strictEqual(skippedFormatted.prefix, "[ ] ", "Skipped item should use [ ] prefix");
assert.strictEqual(skippedFormatted.colorRole, "muted", "Skipped item should use the muted theme role");
assert.strictEqual(skippedFormatted.formatted, "[ ] Skipped task", "Skipped item should format correctly");


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


const allFormatted = formatted.map(f => f.formatted).join("\n");
assert.ok(!allFormatted.includes("done"), "Output should not contain 'done' label");
assert.ok(!allFormatted.includes("now"), "Output should not contain 'now' label");
assert.ok(!allFormatted.includes("next"), "Output should not contain 'next' label");
assert.ok(!allFormatted.includes("failed"), "Output should not contain 'failed' label");
assert.ok(!allFormatted.includes("skip"), "Output should not contain 'skip' label");


const roles = [doneFormatted, runningFormatted, pendingFormatted, failedFormatted].map(item => item.colorRole);
assert.ok(roles.every(role => typeof role === "string"), "All plan colors should use semantic theme roles");

assert.equal(completedPlanCount(items), 1, "Only evidenced completed items should count toward Plan progress");

const longTitle = "session.js: finalize init generation exactly once at finish event, stop shimmer immediately";
const key = planItemKey("plan-1", { id: "step-2", description: longTitle });
assert.strictEqual(key, "plan-1:step-2", "Plan row keys must use stable IDs");
assert.ok(!key.includes(longTitle), "Plan titles must never become React keys");
assert.strictEqual(planItemKey("plan-1", { id: "step-4", description: longTitle }), "plan-1:step-4");
assert.ok(!planItemKey("plan-1", { id: "step-4", description: longTitle }).includes(longTitle));
