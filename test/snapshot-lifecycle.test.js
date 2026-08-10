import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionService } from "../app/permission.js";
import { Registry } from "../app/registry.js";
import { ToolExecutor } from "../app/tool-executor.js";
import { ToolLifecycle } from "../app/tool-lifecycle.js";

test("snapshot preparation runs only before a potentially mutating tool", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-snapshot-lifecycle-"));
  const registry = new Registry();
  for (const name of ["read", "edit"]) {
    registry.register({
      name,
      description: name,
      parameters: { type: "object", properties: {} },
      execute: () => `${name} result`,
    });
  }
  const snapshots = [];
  const executor = new ToolExecutor({
    registry,
    lifecycle: new ToolLifecycle({ sessionId: "snapshot", workspace }),
    permissionService: new PermissionService(workspace, { permission: {} }),
    permissionHandler: async () => "Allow once",
    workspace,
    sessionId: "snapshot",
    beforeExecute: call => snapshots.push(call.name),
  });
  for (const call of [{ id: "read", name: "read", args: {} }, { id: "edit", name: "edit", args: {} }]) {
    for await (const _event of executor.execute(call)) {}
  }
  assert.deepEqual(snapshots, ["edit"]);
});
