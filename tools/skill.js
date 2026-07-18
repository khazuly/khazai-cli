import { PermissionService } from "../app/permission.js";
import { SkillService } from "../app/skills.js";

function xml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function availableDescription(service, permissions) {
  const skills = service.list().filter(skill =>
    permissions.evaluate("skill", { name: skill.name }).decision !== "deny"
  );
  const entries = skills.map(skill =>
    `  <skill><name>${xml(skill.name)}</name><description>${xml(skill.description.replace(/\s+/g, " "))}</description></skill>`
  );
  return [
    "Load reusable khazai-ai instructions from a SKILL.md file.",
    "<available_skills>",
    ...entries,
    "</available_skills>",
  ].join("\n");
}

export function createSkillTool(workspace) {
  const service = new SkillService(workspace);
  const permissions = new PermissionService(workspace);
  return {
    name: "skill",
    get description() {
      return availableDescription(service, permissions);
    },
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact skill name from available_skills." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    async execute({ name }) {
      const skill = service.load(name);
      if (!skill) return `Skill "${String(name || "")}" is not available.`;
      return [
        `Skill: ${skill.name}`,
        `Description: ${skill.description}`,
        `Root: ${skill.root}`,
        "",
        "<skill_content>",
        skill.content,
        "</skill_content>",
      ].join("\n");
    },
  };
}
