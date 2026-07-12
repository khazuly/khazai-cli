import { countTokens } from "../lib/tokens.js";
import { loadConfig, findProjectInstructions } from "../config/index.js";
import { chat, resetSession } from "../lib/llm.js";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extractPlan(text) {
  const items = [];
  const re = /\[\s*([ .xX])\s*\]\s+(.+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const ch = m[1];
    items.push({
      status: ch === "x" || ch === "X" ? "done" : "pending",
      description: m[2].trim(),
    });
  }
  return items;
}

export class Agent {
  constructor(registry, opts = {}) {
    this._registry = registry;
    this._config = loadConfig();
    this._model = opts.model || this._config.model;
    this._workspace = opts.workspace || process.cwd();
    this._messages = [];
    this._lastAnalysis = null;
    this._turn = 0;
    this._aborted = false;
    this._plan = null;
    this._planIndex = 0;
  }

  abort() { this._aborted = true; }
  setModel(model) { this._model = model; }

  _buildSystem() {
    const parts = [
      this._config.system,
      "",
      "You are a coding agent with file/search/shell/web tools. Respond in the user's language.",
      "",
      "RULES:",
      "- Call tools one at a time: {\"tool\":\"name\",\"args\":{...}} — no extra text.",
      "- Never narrate steps. Just call the next tool immediately.",
      "- When user asks to create/write files, do it immediately. No confirmation needed.",
      "- When user asks to delete, list files first with ls/glob, then delete specific files.",
      "- Never ask 'Do you want me to...' — just do it.",
      "- Keep final answers short. Use **bold** and `code` sparingly.",
      "- If edit fails (syntax/text not found), re-read the file and retry with write.",
      `- Workspace: ${this._workspace}. Stay inside.`,
      "",
    ];
    if (this._lastAnalysis) {
      parts.push("LATEST ANALYSIS:", this._lastAnalysis, "");
    }
    const proj = findProjectInstructions();
    if (proj) parts.push("Project instructions:", proj, "");
    parts.push(this._registry.buildPromptBlock());
    return parts.join("\n");
  }

  _extractTool(text) {
    const reply = text.trim();
    const looksLikeTool = /["']tool["']\s*:/.test(reply);
    let parsed;
    try {
      parsed = JSON.parse(reply);
    } catch {
      return looksLikeTool
        ? { tool: null, error: "Tool calls must be one valid JSON object; multiple or malformed JSON objects are not allowed." }
        : { tool: null, error: null };
    }

    if (typeof parsed?.tool !== "string" || !parsed.tool.trim() || !isObject(parsed.args)) {
      return looksLikeTool
        ? { tool: null, error: 'A tool response must have the exact shape {"tool":"name","args":{...}}.' }
        : { tool: null, error: null };
    }
    return { tool: { name: parsed.tool, args: parsed.args }, error: null };
  }

  _compactMessages() {
    const KEEP_RECENT = 14;
    if (this._messages.length <= KEEP_RECENT + 4) return;

    const compacted = [{ role: "user", content: "(Earlier turns: tools executed, edits applied, analyses completed. Details compacted to save context.)" }];
    this._messages = [this._messages[0], ...compacted, ...this._messages.slice(-KEEP_RECENT)];
  }

  _buildContext() {
    const ctx = [];
    let used = 0;
    const sys = this._buildSystem();

    const first = this._messages[0];
    const userContent = first ? first.content : "";

    ctx.push({ role: "user", content: `[System]\n${sys}\n\n${userContent}` });
    used += countTokens(sys) + countTokens(userContent);

    for (let index = this._messages.length - 1; index > 0; index--) {
      const m = this._messages[index];
      const sz = countTokens(m.content);
      if (used + sz > this._config.tokenBudget) break;
      ctx.splice(1, 0, m);
      used += sz;
    }

    return ctx;
  }

  async *loop(input, signal) {
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

      this._compactMessages();
      const ctx = this._buildContext();
      let reply;
      try { reply = await chat(ctx, { model: this._model }); }
      catch (err) {
        try {
          await resetSession();
          reply = await chat(ctx, { model: this._model });
        } catch (retryErr) {
          yield { type: "error", content: `LLM error: ${retryErr.message}` };
          return;
        }
      }

      if (!reply || !reply.trim()) {
        this._messages.push({ role: "user", content: "The LLM returned an empty response. Retry the last action directly. Do not explain." });
        continue;
      }

      const parsed = this._extractTool(reply);
      const tool = parsed.tool;

      if (parsed.error) {
        this._messages.push({
          role: "user",
          content: `Tool response rejected: ${parsed.error} Return exactly one valid tool JSON object now. Do not explain or answer the user yet.`,
        });
        continue;
      }

      if (!tool) {
        this._messages.push({ role: "assistant", content: reply });
        const plan = extractPlan(reply);
        if (plan.length > 0) {
          this._plan = plan;
          yield { type: "plan", items: plan };
          continue;
        }
        if (/next|let'?s|i'?ll|proceed|going to|calling/i.test(reply)) {
          this._messages.push({
            role: "user",
            content: "Don't narrate what you'll do next. If more work remains, call the next tool directly with a JSON object. If done, give the final answer concisely.",
          });
          continue;
        }
        yield { type: "answer", content: reply };
        return;
      }

      this._messages.push({
        role: "assistant",
        content: JSON.stringify({ tool: tool.name, args: tool.args }),
      });
      if (this._plan && this._plan.length > 0) {
        yield { type: "plan-update", index: this._planIndex, status: "running" };
      }
      yield { type: "tool-call", tool: tool.name, args: tool.args };

      const t = this._registry.get(tool.name);
      let result;
      if (!t) {
        result = `Unknown tool "${tool.name}". Available: ${this._registry.list().map(x => x.name).join(", ")}`;
      } else {
        try { result = await t.execute(tool.args); }
        catch (err) { result = `Error: ${err.message}`; }
      }
      if (tool.name === "analyze" && !result.startsWith("Error:")) {
        this._lastAnalysis = result.slice(0, 1000);
      }
      yield { type: "tool-result", tool: tool.name, result };
      if (this._plan && this._plan.length > 0) {
        const failed = result.startsWith("Error") || result.startsWith("Syntax validation") || result.startsWith("Exit: -1");
        yield { type: "plan-update", index: this._planIndex, status: failed ? "failed" : "done" };
        this._planIndex++;
      }

      if (["edit", "write"].includes(tool.name) && (result.startsWith("Syntax validation failed") || result.startsWith("Error: text not found"))) {
        const detail = result.startsWith("Syntax validation failed") ? result : "the provided oldString did not match any text in the file";
        this._messages.push({
          role: "user",
          content: `The requested fix was not applied:\n${detail}\n\nAnalyze the problem:\n1. Syntax error → fix the code, use write to rewrite the entire file\n2. Missing dependency detected in the result → install it with npm install/pip install\n3. Text not found → read the file first, then use write with the corrected content\nThe user already asked for a fix; do not ask for confirmation.`,
        });
        continue;
      }

      let verifyExtra = "";
      if (tool.name === "edit" && !result.startsWith("Error:") && !result.startsWith("No changes")) {
        const ext = tool.args?.path ? tool.args.path.split(".").pop().toLowerCase() : "";
        const verifyCmds = {
          py: `python3 -c "import ast; ast.parse(open('${tool.args.path}').read())"`,
          js: `node --check ${tool.args.path}`,
          mjs: `node --check ${tool.args.path}`,
          cjs: `node --check ${tool.args.path}`,
          json: `python3 -c "import json; json.load(open('${tool.args.path}'))"`,
        };
        const cmd = verifyCmds[ext];
        if (cmd) verifyExtra = `\n\nVerify the fix:\n  ${cmd}`;
      }
      this._messages.push({ role: "user", content: `---TOOL RESULT: ${tool.name}---\n${result.slice(0, 1500)}${result.length > 1500 ? "\n...(truncated)" : ""}${verifyExtra}` });
    }
    yield { type: "error", content: `Maximum tool turns (${this._config.maxTurns}) reached before completion.` };
  }
}
