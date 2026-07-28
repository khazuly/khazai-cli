import { readTool, writeTool, editTool } from "../tools/file.js";
import { globTool, grepTool } from "../tools/search.js";
import { bashTool } from "../tools/shell.js";
import { webSearchTool } from "../tools/websearch.js";
import { questionTool } from "../tools/question.js";
import { taskTool } from "../tools/task.js";
import { webfetchTool } from "../tools/webfetch.js";
import { createSkillTool } from "../tools/skill.js";
import { todoWriteTool } from "../tools/todo.js";

export function builtinTools(workspace) {
  return [
    questionTool,
    bashTool,
    readTool,
    globTool,
    grepTool,
    editTool,
    writeTool,
    taskTool,
    webfetchTool,
    todoWriteTool,
    webSearchTool,
    createSkillTool(workspace),
  ];
}
