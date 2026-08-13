import { resolveModelDescriptor } from "../../lib/llm.js";
import { redactSecrets } from "../../lib/secrets.js";
import { getFamilyPrompt, getModePrompt, resolvePromptProfile } from "../prompts.js";
import { resolve } from "node:path";
import { isObject } from "./helpers/task.js";
import { isProviderParseFailure, extractJsonCandidates, extractTaggedToolCall, jsonCompletion } from "./helpers/parser.js";


export class StatePromptMethods {
  _buildSystem() {
    const revision = this._instructionService.revision();
    const mcpInstructions = [...new Set(this._registry.list()
      .map(tool => tool.mcp?.instructions)
      .filter(Boolean))];
    const hasSkillTool = Boolean(this._registry.get("skill"));
    const skillRevision = hasSkillTool ? this._skillService.revision() : "";
    let descriptor;
    try {
      descriptor = resolveModelDescriptor(this._model, this._config);
    } catch {
      descriptor = { exactID: this._model, modelID: this._model, definition: {} };
    }
    const promptProfile = resolvePromptProfile(descriptor);
    const date = new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
    const cacheKey = JSON.stringify({
      model: this._model,
      exactModel: descriptor.exactID,
      promptProfile,
      mode: this.mode(),
      agent: this._agentProfile?.name,
      profileInstructions: this._agentProfile?.instructions || "",
      analysis: this._lastAnalysis || "",
      revision,
      toolRevision: this._registry.revision,
      skillRevision,
      date,
    });
    if (this._systemCache?.key === cacheKey) return this._systemCache.value;
    const instructionBlock = this._instructionService.getSystemPromptBlock();
    const skills = hasSkillTool
      ? this._skillService.list().filter(skill => (
        this._permissionService.evaluate("skill", { name: skill.name }).decision !== "deny"
      ))
      : [];

    const envInfo = [
      `You are powered by the model ${descriptor.exactID}.`,
      `Here is some useful information about the environment you are running in:`,
      `<env>`,
      `  Working directory: ${this._workspaceMetadata.workingDirectory}`,
      `  Worktree: ${this._workspaceMetadata.worktree}`,
      `  Is directory a git repo: ${this._workspaceMetadata.isGitRepo ? "yes" : "no"}`,
      `  Platform: ${process.platform}`,
      `  Today's date: ${date}`,
      `</env>`,
      "",
    ].join("\n");

    const parts = [getFamilyPrompt(descriptor), getModePrompt(this.mode()), envInfo];
    if (instructionBlock) parts.push(instructionBlock, "");
    if (mcpInstructions.length) {
      parts.push(
        "MCP SERVER INSTRUCTIONS:",
        "Use an MCP tool when the user or workspace instructions explicitly require its server. Never claim MCP results that were not retrieved.",
        ...mcpInstructions,
        "",
      );
    }
    if (this._agentProfile?.instructions) {
      parts.push("ACTIVE AGENT PROFILE:", this._agentProfile.instructions, "");
    }
    if (skills.length) {
      parts.push(
        "AVAILABLE SKILLS:",
        "Use the skill tool to load a skill's full instructions when its description matches the task.",
        ...skills.map(skill => `- ${skill.name}: ${skill.description}`),
        "",
      );
    }

    if (this._lastAnalysis) {
      parts.push("LATEST ANALYSIS:", this._lastAnalysis, "");
    }
    const value = parts.join("\n");
    this._systemCache = { key: cacheKey, value };
    return value;
  }

  _parseToolJson(parsed) {
    if (typeof parsed === "string") {
      try { return this._parseToolJson(JSON.parse(parsed)); } catch { return null; }
    }
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        const tool = this._parseToolJson(entry);
        if (tool) return tool;
      }
      return null;
    }
    if (typeof parsed?.tool === "string" && parsed.tool.trim() && isObject(parsed.args)) {
      const tool = { name: parsed.tool, args: parsed.args };
      const id = parsed.id || parsed.tool_call_id;
      if (id) tool.id = id;
      return tool;
    }
    if (typeof parsed?.tool === "string" && parsed.tool.trim() && isObject(parsed.arguments)) {
      return { name: parsed.tool, args: parsed.arguments };
    }
    if (typeof parsed?.tool === "string" && parsed.tool.trim()) {
      const registered = this._registry.get(parsed.tool);
      const properties = registered?.parameters?.properties || {};
      const args = Object.fromEntries(
        Object.keys(properties)
          .filter(key => Object.hasOwn(parsed, key))
          .map(key => [key, parsed[key]]),
      );
      if (registered && Object.keys(args).length > 0) {
        return { name: parsed.tool, args };
      }
    }
    if (typeof parsed?.name === "string" && parsed.name.trim()) {
      let args = parsed.arguments ?? parsed.input ?? parsed.parameters;
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { args = null; }
      }
      if (isObject(args)) return { name: parsed.name, args };
    }
    if (isObject(parsed?.function)) {
      return this._parseToolJson(parsed.function);
    }
    for (const container of [parsed?.tool_calls, parsed?.function_calls, parsed?.content]) {
      if (Array.isArray(container)) {
        const tool = this._parseToolJson(container);
        if (tool) return tool;
      }
    }
    const keys = Object.keys(parsed || {});
    if (keys.length === 1 && isObject(parsed[keys[0]]) && this._registry.get(keys[0])) {
      return { name: keys[0], args: parsed[keys[0]] };
    }
    return null;
  }

  _toolBatchLimit() {
    return Math.max(1, Math.min(50, Number(this._applyEffectiveSettings().maxToolsPerIteration) || 8));
  }

  _extractNativeTool(text) {
    try {
      const parsed = JSON.parse(String(text || "").trim());
      if (Array.isArray(parsed)) {
        const tools = parsed.slice(0, this._toolBatchLimit()).map(entry => this._parseToolJson(entry)).filter(Boolean);
        return tools.length ? { tool: tools[0], tools, error: null, kind: null } : { tool: null, error: null, kind: null };
      }
      const tool = this._parseToolJson(parsed);
      return { tool, error: null, kind: null };
    } catch {
      return { tool: null, error: "Native tool call payload was malformed.", kind: "malformed_json", truncated: false };
    }
  }

  _extractTool(text) {
    const reply = text.trim();
    const toolNames = this._registry.list().map(t => t.name).join("|");

    if (isProviderParseFailure(reply)) {
      return { tool: null, error: "provider response could not be parsed", truncated: false, kind: "provider_parse_failure" };
    }

    try {
      const parsed = JSON.parse(reply);
      if (Array.isArray(parsed)) {
        const tools = parsed.slice(0, this._toolBatchLimit()).map(entry => this._parseToolJson(entry)).filter(Boolean);
        if (tools.length) return { tool: tools[0], tools, error: null, kind: null };
      }
      const tool = this._parseToolJson(parsed);
      if (tool) return { tool, error: null, kind: null };
    } catch {}

    for (const candidate of extractJsonCandidates(reply)) {
      try {
        const parsed = JSON.parse(candidate);
        const tool = this._parseToolJson(parsed);
        if (tool) return { tool, error: null, kind: null };
      } catch { continue; }
    }

    const taggedTool = extractTaggedToolCall(reply, this._registry);
    if (taggedTool) return { tool: taggedTool, error: null, kind: null };

    const toolLike = /<\s*\/?\s*(?:function|tool)_calls?/i.test(reply)
      || /<\s*(?:invoke|tool_call)\b/i.test(reply)
      || /["']tool["']\s*:/i.test(reply)
      || /["'](?:tool_calls|function_calls|tool_use)["']\s*:/i.test(reply)
      || new RegExp(`["'](?:${toolNames})["']\\s*:`).test(reply);
    if (toolLike) {
      const completion = jsonCompletion(reply);
      const truncated = completion === "truncated";
      return {
        tool: null,
        error: truncated
          ? "The tool call was truncated before its JSON payload completed."
          : "Found tool-like text but could not parse a valid JSON tool call.",
        truncated,
        kind: truncated ? "truncated_json" : "malformed_json",
      };
    }

    return { tool: null, error: null, kind: null };
  }

  _steer({ detectedIntent, proposedAction, recommendedAction, guidance }) {
    const event = {
      type: "steering",
      needsSteering: true,
      detectedIntent: detectedIntent || this._taskContract?.category || "UNKNOWN",
      proposedAction: proposedAction || "tool action",
      recommendedAction: recommendedAction || "continue safely",
      guidance: redactSecrets(guidance || "Continue from the current task state with a safe next action."),
    };
    this._appendMessage({
      role: "user",
      content: `[INTERNAL STEERING]\nDetected intent: ${event.detectedIntent}\nProposed action: ${event.proposedAction}\nRecommended action: ${event.recommendedAction}\nGuidance: ${event.guidance}`,
    });
    return event;
  }

  _toolRecoveryInstruction(kind, attempt, detail = "") {
    const common = "Continue the current task from the existing plan, tool results, and unfinished action; do not restart. Return exactly one complete JSON tool call, with no markdown or surrounding text.";
    const compact = "Use one operation only. Do not combine actions. Keep arguments small; for a large edit, first inspect or make one smaller edit per step.";
    const guidance = {
      truncated_json: `Your previous tool JSON was cut off. ${compact} If content is large, split it into several valid write/edit operations. Ensure every quote, brace, and array is closed.`,
      malformed_json: `Your previous tool JSON was malformed. ${compact} Follow the tool schema exactly and emit valid JSON only.`,
      unknown_tool: "The requested tool does not exist. Choose one tool from the supplied tool schema and preserve the current unfinished action.",
      missing_required_argument: `The call omitted ${detail || "a required argument"}. Include every required argument from the selected tool schema. ${compact}`,
      schema_validation: `The call does not match the selected tool schema (${detail || "invalid arguments"}). Correct argument names and types. ${compact}`,
      provider_parse_failure: `The previous provider response was not usable. ${compact} Reissue the next expected action using the current task state and tool schema.`,
    };
    const escalation = attempt > 1
      ? " The previous correction did not produce an executable call. Change strategy now: inspect the exact target first when context is missing; for an existing file, use one edit patch with exact oldString/newString; for a new file, use one small write; for shell work, run one command only."
      : "";
    return `Internal tool-call recovery: ${guidance[kind] || guidance.malformed_json}${escalation}\n${common}`;
  }

  _normalizeTool(tool) {
    const canonicalName = this._registry.resolveName?.(tool?.name);
    return canonicalName && canonicalName !== tool.name
      ? { ...tool, name: canonicalName }
      : tool;
  }

  _prepareToolArgs(name, input) {
    const args = { ...(input || {}) };
    if (name === "bash") {
      args.workdir = args.workdir
        ? resolve(this._workspace, String(args.workdir))
        : this._workspace;
    }
    if (["read", "write", "edit", "analyze", "glob", "grep"].includes(name)
      && args.path && !String(args.path).startsWith("/")) {
      args.path = resolve(this._workspace, String(args.path));
    }
    if (["read", "write", "edit", "apply_patch", "analyze", "glob", "grep", "task"].includes(name)) {
      args._agentWorkspace = this._workspace;
    }
    return args;
  }

}
