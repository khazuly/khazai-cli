import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import { homedir } from "node:os";

const INSTRUCTION_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "CONTEXT.md",
];

const GLOBAL_INSTRUCTION_FILES = [
  "AGENTS.md",
];

const MAX_INSTRUCTION_CHARS = 3000;

export class InstructionService {
  constructor(workspace) {
    this.workspace = workspace;
    this.cache = new Map();
  }

  findUp(filename, startDir) {
    let current = startDir;
    while (current && current !== dirname(current)) {
      const filepath = join(current, filename);
      if (existsSafe(filepath)) {
        return filepath;
      }
      current = dirname(current);
    }
    return null;
  }

  loadGlobalInstructions() {
    const globalDir = join(homedir(), ".config", "khazai-ai");
    const results = [];

    for (const filename of GLOBAL_INSTRUCTION_FILES) {
      const filepath = join(globalDir, filename);
      if (existsSafe(filepath)) {
        const content = readFileSafe(filepath);
        if (content) {
          results.push({ filepath, content });
        }
      }
    }

    return results;
  }

  loadProjectInstructions() {
    const results = [];

    for (const filename of INSTRUCTION_FILES) {
      const filepath = this.findUp(filename, this.workspace);
      if (filepath && !results.some(r => r.filepath === filepath)) {
        const content = readFileSafe(filepath);
        if (content) {
          results.push({ filepath, content });
        }
      }
    }

    return results;
  }

  loadAllInstructions() {
    const cacheKey = this.workspace;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    const global = this.loadGlobalInstructions();
    const project = this.loadProjectInstructions();
    const all = [...global, ...project];

    this.cache.set(cacheKey, all);
    return all;
  }

  getSystemPromptBlock() {
    const instructions = this.loadAllInstructions();
    if (instructions.length === 0) return "";

    const lines = ["INSTRUCTIONS:"];
    for (const { filepath, content } of instructions) {
      const truncated = content.trim().length > MAX_INSTRUCTION_CHARS
        ? content.trim().slice(0, MAX_INSTRUCTION_CHARS) + "\n...(truncated)"
        : content.trim();
      lines.push(`# From ${filepath}`);
      lines.push(truncated);
      lines.push("");
    }

    return lines.join("\n");
  }

  clearCache() {
    this.cache.clear();
  }
}

function existsSafe(filepath) {
  try {
    return existsSync(filepath) && statSync(filepath).isFile();
  } catch {
    return false;
  }
}

function readFileSafe(filepath) {
  try {
    return readFileSync(filepath, "utf-8");
  } catch {
    return null;
  }
}
