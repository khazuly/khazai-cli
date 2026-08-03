import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionService, externalPaths, shellPermissionEvidence } from "../app/permission.js";
import { Registry } from "../app/registry.js";
import { ToolExecutor } from "../app/tool-executor.js";
import { ToolLifecycle } from "../app/tool-lifecycle.js";
import { parseShellCommand } from "../app/shell-command-parser.js";

function workspace() {
  return mkdtempSync(join(tmpdir(), "khazai-shell-targets-"));
}

function paths(command, root) {
  return externalPaths("bash", { command, workdir: root }, root);
}

function parsed(command, root) {
  return parseShellCommand(command, root).commands.map(entry => ({
    command: entry.command,
    patterns: entry.patterns,
    paths: entry.paths,
  }));
}

async function approvalRequests(command, root, permission = { bash: { "*": "ask" } }) {
  const registry = new Registry();
  registry.register({
    name: "bash",
    description: "Shell",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    execute: () => "done",
  });
  const requests = [];
  const executor = new ToolExecutor({
    registry,
    lifecycle: new ToolLifecycle({ sessionId: "shell-target-test", workspace: root }),
    permissionService: new PermissionService(root, { permission }),
    permissionHandler: async request => {
      requests.push(request);
      return "Reject";
    },
    workspace: root,
    sessionId: "shell-target-test",
  });
  for await (const _event of executor.execute({
    name: "bash",
    args: { command, workdir: root },
    id: "shell-target-call",
  })) {}
  return requests;
}

test("grep patterns beginning with slash are not filesystem targets", () => {
  const root = workspace();
  const result = parsed('grep -n "/help utk bantuan" deepseek.py', root)[0];
  assert.deepEqual(result, {
    command: "grep",
    patterns: ["/help utk bantuan"],
    paths: [join(root, "deepseek.py")],
  });
  assert.deepEqual(paths('grep -n "/help utk bantuan" deepseek.py', root), []);
  assert.deepEqual(parsed('grep -n "/api/v1" src/server.js', root)[0].paths, [join(root, "src/server.js")]);
  assert.deepEqual(parsed('grep -e "/root/" app.log', root)[0], {
    command: "grep",
    patterns: ["/root/"],
    paths: [join(root, "app.log")],
  });
});

test("grep file operands retain external-path protection", () => {
  const root = workspace();
  assert.deepEqual(paths('grep "root" /etc/passwd', root), ["/etc/passwd"]);
});

test("semicolon-separated grep commands classify operands independently", () => {
  const root = workspace();
  const commands = parsed('grep -n "/help utk bantuan" deepseek.py; grep -n "model_type" deepseek.py', root);
  assert.deepEqual(commands.map(entry => entry.patterns), [["/help utk bantuan"], ["model_type"]]);
  assert.deepEqual(commands.map(entry => entry.paths), [[join(root, "deepseek.py")], [join(root, "deepseek.py")]]);
  assert.deepEqual(paths('grep -n "/help utk bantuan" deepseek.py; grep -n "model_type" deepseek.py', root), []);
});

test("quoted options, terminators, escaped spaces, pipes, and boolean separators retain argument roles", () => {
  const root = workspace();
  const command = 'grep --include "*.js" -- "/api/v1" src/server\\ file.js | sed -n "1,20p" && echo "/etc/passwd" || true';
  const commands = parsed(command, root);
  assert.deepEqual(commands[0].patterns, ["/api/v1"]);
  assert.deepEqual(commands[0].paths, [join(root, "src/server file.js")]);
  assert.deepEqual(commands[1].patterns, ["1,20p"]);
  assert.deepEqual(commands[1].paths, []);
  assert.deepEqual(paths(command, root), []);
});

test("sed expressions and echoed strings are not filesystem targets", () => {
  const root = workspace();
  assert.deepEqual(parsed("sed -n '1,20p' deepseek.py", root)[0], {
    command: "sed",
    patterns: ["1,20p"],
    paths: [join(root, "deepseek.py")],
  });
  assert.deepEqual(paths("sed -n '1,20p' deepseek.py", root), []);
  assert.deepEqual(paths('echo "/etc/passwd"', root), []);
});

test("cat and redirection targets outside the workspace still require approval", () => {
  const root = workspace();
  assert.deepEqual(paths("cat /etc/passwd", root), ["/etc/passwd"]);
  assert.deepEqual(paths("printf output > /tmp/output.txt", root), ["/tmp/output.txt"]);
  assert.deepEqual(paths("env MODE=test cat /etc/passwd", root), ["/etc/passwd"]);
  assert.deepEqual(paths("command cat /etc/passwd", root), ["/etc/passwd"]);
  assert.deepEqual(paths("npm --prefix /root/other-project test", root), ["/root/other-project"]);
});

test("relative operands resolve against the effective shell working directory", () => {
  const root = workspace();
  const nested = join(root, "nested");
  const command = `cd "${nested}" && grep "model" deepseek.py`;
  const result = parsed(command, root);
  assert.equal(result[1].paths[0], join(nested, "deepseek.py"));
  assert.deepEqual(paths(command, root), []);
  assert.deepEqual(paths("cd /root/other-project && npm test", root), ["/root/other-project"]);
});

test("shell boundary checks canonicalize symlink targets", () => {
  const root = workspace();
  const outside = workspace();
  symlinkSync(outside, join(root, "linked-outside"));
  assert.deepEqual(paths("cat linked-outside/file.txt", root), [join(outside, "file.txt")]);
});

test("allow-all suppresses workspace-only shell approval", async () => {
  const root = workspace();
  const service = new PermissionService(root, { permission: { bash: { "*": "ask" } } });
  await service.setAllowAll(true);
  const args = { command: 'grep -n "/help utk bantuan" deepseek.py', workdir: root };
  assert.equal(service.evaluateExternalDirectory("bash", args), null);
  assert.equal(service.evaluate("bash", args).decision, "allow");
  assert.equal(service.evaluate("bash", {
    command: 'custom-command --payload "/etc/passwd"',
    workdir: root,
  }).decision, "ask");
});

test("permission evidence contains only classified filesystem targets", () => {
  const root = workspace();
  const evidence = shellPermissionEvidence({
    command: 'grep -n "/help utk bantuan" deepseek.py',
    workdir: root,
  }, root);
  assert.equal(evidence.action, "shell");
  assert.equal(evidence.workspaceRoot, root);
  assert.equal(evidence.workingDirectory, root);
  assert.deepEqual(evidence.filesystemTargets, [root, join(root, "deepseek.py")]);
  assert.deepEqual(evidence.externalTargets, []);
  assert.doesNotMatch(JSON.stringify(evidence.filesystemTargets), /help utk bantuan/);
});

test("path persistence is offered only for verified external targets", async () => {
  const root = workspace();
  for (const command of [
    'grep -n "/help utk bantuan" deepseek.py',
    'echo "https://example.com/api/v1"',
    'printf "%s" "/etc/passwd"',
    'custom-command --payload "/etc/passwd"',
  ]) {
    const [request] = await approvalRequests(command, root);
    assert.equal(request.target.label, "Command");
    assert.equal(request.options.includes("Always allow this path"), false);
    assert.equal(request.options.includes("Always allow this action"), true);
    if (command.startsWith("custom-command")) assert.match(request.action, /unclassified shell command/);
  }
  const [external] = await approvalRequests("cat /etc/passwd", root, { bash: "allow" });
  assert.deepEqual(external.evidence.externalTargets, ["/etc/passwd"]);
  assert.deepEqual(external.target, { label: "Path", value: "/etc/passwd" });
  assert.equal(external.options.includes("Always allow this path"), true);
});
