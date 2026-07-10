import { countTokens } from "../lib/tokens.js";
import { loadConfig, findProjectInstructions } from "../config/index.js";
import { chat } from "../lib/llm.js";

const TOOL_RE = /^\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"args"\s*:\s*(\{.*?\})\s*\}$/s;

export class Agent {
  constructor(registry, opts = {}) {
    this._registry = registry;
    this._config = loadConfig();
    this._model = opts.model || this._config.model;
    this._workspace = opts.workspace || process.cwd();
    this._messages = [];
    this._turn = 0;
    this._aborted = false;
  }

  abort() { this._aborted = true; }

  _buildSystem() {
    const parts = [
      this._config.system,
      "",
      "You are a coding agent. You have file/search/shell tools.",
      "",
      "CONVERSATION PATTERN:",
      "User → you call a tool (JSON) → tool result comes back → you give final answer in text.",
      "Never describe what you will do. Just call the tool. Then answer.",
      "",
      "EXAMPLES:",
      'Q: "list files" → A: {"tool":"glob","args":{"pattern":"*"}}',
      "Result: Found 10 files. → A: Here are the files: ...",
      'Q: "what is 2+2?" → A: 4 (no tool needed)',
      "",
      'Tool format: {"tool":"<name>","args":{<params>}} — respond with ONLY this JSON, no extra text.',
      "Tool result format: [tool_name]\\n<output>",
      `Workspace: ${this._workspace}. Stay inside this directory.`,
      "",
    ];
    const proj = findProjectInstructions();
    if (proj) parts.push("Project instructions:", proj, "");
    parts.push(this._registry.buildPromptBlock());
    return parts.join("\n");
  }

  _extractTool(text) {
    const m = TOOL_RE.exec(text.trim());
    if (!m) return null;
    try { return { name: m[1], args: JSON.parse(m[2]) }; }
    catch { return null; }
  }

  _buildContext() {
    const ctx = [];
    let used = 0;
    const sys = this._buildSystem();
    ctx.push({ role: "user", content: `[System]\n${sys}` });
    used += countTokens(sys);
    for (const m of this._messages) {
      const sz = countTokens(m.content);
      if (used + sz > this._config.tokenBudget) break;
      ctx.push(m);
      used += sz;
    }
    return ctx;
  }

  async *loop(input, signal) {
    this._consecutiveTools = 0;
    this._forceAnswer = false;
    this._messages.push({ role: "user", content: input });
    this._turn = 0;
    this._aborted = false;

    while (this._turn < this._config.maxTurns) {
      if (this._aborted || signal?.aborted) {
        yield { type: "error", content: "Aborted" };
        return;
      }
      this._turn++;
      yield { type: "thinking", turn: this._turn };

      const ctx = this._buildContext();
      let reply;
      try { reply = await chat(ctx, { model: this._model }); }
      catch (err) { yield { type: "error", content: `LLM error: ${err.message}` }; return; }

      const tool = this._extractTool(reply);

      if (tool) {
        this._consecutiveTools++;
      } else {
        this._consecutiveTools = 0;
      }

      if (this._consecutiveTools >= 5 && !this._forceAnswer) {
        this._forceAnswer = true;
        this._messages.push({ role: "user", content: "No more tools. Give your final answer now." });
        continue;
      }

      if (this._forceAnswer) {
        this._messages.push({ role: "assistant", content: reply });
        yield { type: "answer", content: reply };
        return;
      }

      if (!tool) {
        this._messages.push({ role: "assistant", content: reply });
        yield { type: "answer", content: reply };
        return;
      }

      this._messages.push({
        role: "assistant",
        content: JSON.stringify({ tool: tool.name, args: tool.args }),
      });
      yield { type: "tool-call", tool: tool.name, args: tool.args };

      const t = this._registry.get(tool.name);
      let result;
      if (!t) {
        result = `Unknown tool "${tool.name}". Available: ${this._registry.list().map(x => x.name).join(", ")}`;
      } else {
        try { result = await t.execute(tool.args); }
        catch (err) { result = `Error: ${err.message}`; }
      }
      yield { type: "tool-result", tool: tool.name, result };
      this._messages.push({ role: "user", content: `[${tool.name}]\n${result}\n\nNow give your final answer.` });
    }
    yield { type: "answer", content: "Max turns reached." };
  }
}
