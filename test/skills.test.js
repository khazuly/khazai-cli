import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../app/agent.js";
import { getAgentProfile } from "../app/agent-profiles.js";
import { fallbackIntentContract } from "../app/intent-resolver.js";
import { PermissionService } from "../app/permission.js";
import { Registry } from "../app/registry.js";
import { MAX_SKILL_BYTES, SkillService } from "../app/skills.js";
import { createSkillTool } from "../tools/skill.js";
import { COMMANDS } from "../ui/commands.js";

function writeSkill(root, name, description, body = "Use this workflow.") {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "metadata:",
    "  audience: developers",
    "---",
    body,
  ].join("\n"));
  return directory;
}

test("skill discovery supports common paths and deterministic precedence", () => {
  const repository = mkdtempSync(join(tmpdir(), "khazai-skills-repo-"));
  const workspace = join(repository, "packages", "app");
  const home = mkdtempSync(join(tmpdir(), "khazai-skills-home-"));
  mkdirSync(workspace, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repository });

  writeSkill(join(home, ".config", "khazai-ai", "skills"), "release", "global khazai");
  writeSkill(join(repository, ".agents", "skills"), "release", "root agents");
  writeSkill(join(repository, ".khazai", "skills"), "release", "root khazai");
  writeSkill(join(workspace, ".opencode", "skills"), "release", "nested opencode");
  writeSkill(join(workspace, ".agents", "skills"), "review", "nested agents");
  writeSkill(join(workspace, ".khazai", "skills"), "release", "nested khazai");

  const skills = new SkillService(workspace, { home }).list();
  assert.deepEqual(skills.map(skill => skill.name), ["release", "review"]);
  assert.equal(skills.find(skill => skill.name === "release").description, "nested khazai");
  assert.equal(skills.find(skill => skill.name === "release").namespace, "khazai");
  assert.equal(skills.find(skill => skill.name === "review").namespace, "agents");
});

test("skill discovery refreshes and ignores malformed, oversized, mismatched, and symlinked entries", () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-skills-safe-"));
  const home = mkdtempSync(join(tmpdir(), "khazai-skills-safe-home-"));
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  const root = join(workspace, ".khazai", "skills");
  mkdirSync(root, { recursive: true });
  const service = new SkillService(workspace, { home });
  assert.deepEqual(service.list(), []);

  writeSkill(root, "valid-skill", "Valid skill");
  mkdirSync(join(root, "broken"), { recursive: true });
  writeFileSync(join(root, "broken", "SKILL.md"), "---\nname: [broken\n---\n");
  writeSkill(root, "directory-name", "Mismatched name").replace(/directory-name$/, "");
  writeFileSync(join(root, "directory-name", "SKILL.md"), "---\nname: different-name\ndescription: Wrong\n---\n");
  writeSkill(root, "too-large", "Oversized", "x".repeat(MAX_SKILL_BYTES));
  const outside = mkdtempSync(join(tmpdir(), "khazai-skills-outside-"));
  writeSkill(outside, "linked", "Linked");
  symlinkSync(join(outside, "linked"), join(root, "linked"));

  assert.deepEqual(service.list().map(skill => skill.name), ["valid-skill"]);
  writeSkill(root, "added-later", "Added without restart");
  assert.deepEqual(service.list().map(skill => skill.name), ["added-later", "valid-skill"]);
});

test("native skill tool advertises accessible skills, reloads content, and escapes descriptions", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-skill-tool-"));
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  const root = join(workspace, ".khazai", "skills");
  writeSkill(root, "public-docs", "Use <public> & docs", "Initial instructions.");
  writeSkill(root, "internal-docs", "Private instructions");
  mkdirSync(join(workspace, ".khazai"), { recursive: true });
  writeFileSync(join(workspace, ".khazai", "permissions.json"), JSON.stringify({
    skill: { "*": "allow", "internal-*": "deny" },
  }));

  const tool = createSkillTool(workspace);
  assert.match(tool.description, /public-docs/);
  assert.match(tool.description, /&lt;public&gt; &amp; docs/);
  assert.doesNotMatch(tool.description, /internal-docs/);
  assert.match(await tool.execute({ name: "public-docs" }), /Initial instructions/);

  writeSkill(root, "added-skill", "Discovered live");
  assert.match(tool.description, /added-skill/);
  assert.match(await tool.execute({ name: "missing" }), /not available/);
});

test("skill permissions match skill names and built-in profiles expose the intended tool", () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-skill-permission-"));
  const permissions = new PermissionService(workspace, {
    permission: {
      skill: { "*": "allow", "experimental-*": "ask", "internal-*": "deny" },
    },
  });
  assert.equal(permissions.evaluate("skill", { name: "release" }).decision, "allow");
  assert.equal(permissions.evaluate("skill", { name: "experimental-ui" }).decision, "ask");
  assert.equal(permissions.evaluate("skill", { name: "internal-docs" }).decision, "deny");

  assert.ok(getAgentProfile(workspace, "build").tools.includes("*"));
  assert.ok(getAgentProfile(workspace, "plan").tools.includes("skill"));
  assert.ok(!getAgentProfile(workspace, "explore").tools.includes("skill"));
  assert.ok(COMMANDS.some(command => command.name === "/skills"));
  assert.match(createSkillTool(workspace).description, /khazai-ai/);
});

test("agent permission flow asks before loading an ask-protected skill", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-skill-approval-"));
  const registry = new Registry();
  let executions = 0;
  registry.register({
    name: "skill",
    description: "Load a skill.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    async execute() {
      executions++;
      return "Review instructions loaded.";
    },
  });
  const responses = [
    JSON.stringify({ tool: "skill", args: { name: "experimental-review" } }),
    "The review workflow is ready.",
  ];
  const agent = new Agent(registry, {
    workspace,
    intentResolver: async ({ input }) => fallbackIntentContract(input),
    permissionService: new PermissionService(workspace, {
      permission: { skill: { "*": "allow", "experimental-*": "ask" } },
    }),
    chat: async (_messages, options) => {
      const response = responses.shift();
      options.onToken?.(response);
      return response;
    },
  });
  agent.setPermissionHandler(async () => "Allow once");

  const events = [];
  for await (const event of agent.loop("load the experimental review workflow")) events.push(event);
  assert.equal(events.filter(event => event.type === "permission").length, 1);
  assert.equal(events.find(event => event.type === "permission").pattern, "experimental-review");
  assert.equal(events.filter(event => event.type === "tool-call").length, 1);
  assert.equal(executions, 1);
});
