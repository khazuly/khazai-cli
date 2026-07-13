import { countTokens } from "../lib/tokens.js";
import { loadConfig, findProjectInstructions } from "../config/index.js";
import { chat, resetSession } from "../lib/llm.js";

import { execAsync } from "../lib/exec-async.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

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
    this._lastToolIsRead = false;
    this._depsInstalled = false;
    this._readFiles = new Map();
    this._autoReadDone = new Set();
    this._consecutiveWrites = 0;
    this._consecutiveBash = 0;
  }

  abort() { this._aborted = true; }
  setModel(model) { this._model = model; }

  _cleanAnswer(text) {
    let clean = text
      .replace(/```\w*\n[\s\S]*?```/g, (m) => {
        const code = m.replace(/```\w*\n?/g, "").trim();
        return code;
      })
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return clean;
  }

  _buildSystem() {
    const parts = [
      this._config.system,
      "",
      "You are a coding agent with file/search/shell/web tools.",
      "",
      "TOOL CALL FORMAT:",
      "- Respond with EXACTLY one JSON object: {\"tool\":\"name\",\"args\":{...}}",
      "- No text before or after the JSON. No markdown. No explanation.",
      "",
      "RULES:",
      "- Create/write files immediately when asked. No confirmation needed.",
      "- Never ask 'Do you want me to...' — just do it.",
      "- Keep final answers concise.",
      "- If edit fails, re-read the file and retry with write.",
      "- If a bash command times out (result contains 'Timeout'), do NOT retry it. Tell the user to run it manually.",
      "- Never repeat the exact same broken command.",
      "- READ ONCE then ACT. After reading a file, immediately edit/write/bash.",
      "- Do NOT use bash to read files (cat/tail/head). Use the read tool.",
      "- To check if a directory exists (like node_modules), use: {\"tool\":\"bash\",\"args\":{\"command\":\"ls -d node_modules 2>/dev/null && echo EXISTS || echo MISSING\"}}. Do NOT use glob for directories.",
      "- When all files are written and deps installed, give the final answer.",
      "- Keep final answers SHORT. Just say what was done and how to run it. No extra formatting.",
      "",
      "WHEN USER ASKS TO RUN CODE:",
      "- NEVER start long-lived servers (node server.js, npm start, python3 -m http.server). They block forever.",
      "- Instead, write all files and tell the user how to run it themselves.",
      "",
      "DEPENDENCY MANAGEMENT:",
      "- Before npm install, check if node_modules/ exists using bash: ls -d node_modules.",
      "- If node_modules exists and package.json has not changed, skip npm install.",
      "- Only run npm install when package.json is new or changed.",
      "",
      "- If command times out: run 'ps aux | grep <process>' to find background processes, kill them with 'kill -9 PID', then retry.",
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

  _parseToolJson(parsed) {
    if (typeof parsed?.tool === "string" && parsed.tool.trim() && isObject(parsed.args)) {
      return { name: parsed.tool, args: parsed.args };
    }
    const keys = Object.keys(parsed || {});
    if (keys.length === 1 && isObject(parsed[keys[0]]) && this._registry.get(keys[0])) {
      return { name: keys[0], args: parsed[keys[0]] };
    }
    return null;
  }

  _extractTool(text) {
    const reply = text.trim();
    const toolNames = this._registry.list().map(t => t.name).join("|");

    try {
      const parsed = JSON.parse(reply);
      const tool = this._parseToolJson(parsed);
      if (tool) return { tool, error: null };
    } catch {}

    const jsonCandidates = [];
    const codeBlockRe = /```(?:json|javascript)?\s*\n(\{[\s\S]*?\})\s*\n```/g;
    let m;
    while ((m = codeBlockRe.exec(reply)) !== null) jsonCandidates.push(m[1].trim());
    if (jsonCandidates.length === 0) {
      const standaloneRe = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
      while ((m = standaloneRe.exec(reply)) !== null) jsonCandidates.push(m[0]);
    }

    for (const candidate of jsonCandidates) {
      try {
        const parsed = JSON.parse(candidate);
        const tool = this._parseToolJson(parsed);
        if (tool) return { tool, error: null };
      } catch { continue; }
    }

    if (new RegExp(`"${toolNames}"\\s*:`).test(reply)) {
      return { tool: null, error: "Found tool-like text but could not parse a valid JSON tool call." };
    }

    return { tool: null, error: null };
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
      let chatErr;

      const tokenQueue = [];
      let tokenResolve = null;
      const onToken = (token) => {
        if (tokenResolve) { const r = tokenResolve; tokenResolve = null; r(token); }
        else tokenQueue.push(token);
      };

      const chatDone = chat(ctx, { model: this._model, onToken }).then(r => { reply = r; }).catch(e => { chatErr = e; });

      const waitForToken = () => new Promise(r => { tokenResolve = r; });

      const streamBuf = [];
      let toolSuppressed = false;
      let streamConfirmed = false;
      const PREBUF_MAX = 30;
      while (reply === undefined && chatErr === undefined) {
        let token;
        if (tokenQueue.length > 0) {
          token = tokenQueue.shift();
        } else {
          token = await Promise.race([
            waitForToken(),
            chatDone.then(() => undefined),
          ]);
        }
        if (token === undefined) continue;
        streamBuf.push(token);

        if (toolSuppressed) continue;

        const acc = streamBuf.join("");
        const hasToolJson = /"tool"\s*:/i.test(acc) || /<function_call/i.test(acc) || /^\s*\{"\w+"\s*:/i.test(acc);
        if (hasToolJson) {
          toolSuppressed = true;
          continue;
        }
        if (!streamConfirmed) {
          const startsSuspicious = /^\s*[{\[<]/.test(acc);
          if (!startsSuspicious && streamBuf.length > 3) {
            streamConfirmed = true;
            for (const t of streamBuf) yield { type: "stream", token: t };
          } else if (!startsSuspicious && streamBuf.length >= PREBUF_MAX) {
            streamConfirmed = true;
            for (const t of streamBuf) yield { type: "stream", token: t };
          }
        } else {
          yield { type: "stream", token };
        }
      }
      while (tokenQueue.length > 0) streamBuf.push(tokenQueue.shift());
      await chatDone.catch(() => {});

      if (chatErr) {
        try {
          await resetSession();
          this._streamBuffer = "";
          tokenQueue.length = 0; tokenResolve = null;
          streamBuf.length = 0;
          toolSuppressed = false;
          streamConfirmed = false;
          reply = await chat(ctx, { model: this._model, onToken });
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
        const isNarration = /^(?:Next|Let'?s|I'?ll|Going to|Calling|Now I)/i.test(reply);
        if (isNarration && this._turn < this._config.maxTurns - 1) {
          this._messages.push({
            role: "user",
            content: "Don't narrate what you'll do next. If more work remains, call the next tool directly with a JSON object. If done, give the final answer concisely.",
          });
          continue;
        }
        if (this._lastToolIsRead && this._turn < this._config.maxTurns - 1) {
          this._messages.push({
            role: "user",
            content: "You have the file contents. Do NOT reply with text. Call a tool now — edit or write to make the changes the user requested.",
          });
          this._lastToolIsRead = false;
          continue;
        }
        yield { type: "answer", content: this._cleanAnswer(reply) };
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
        if (tool.name === "bash") {
          tool.args.workdir = this._workspace;
        }
        if (["write", "edit"].includes(tool.name) && tool.args?.path && !tool.args.path.startsWith("/")) {
          tool.args.path = resolve(this._workspace, tool.args.path);
        }
        if (["write", "edit"].includes(tool.name) && tool.args?.path) {
          tool.args._agentWorkspace = this._workspace;
        }
        if (tool.name === "bash" && tool.args?.command && tool.args.workdir) {
          const cmd = tool.args.command;
          if (/^npm\s+install\s+\S/.test(cmd) && !cmd.includes("--prefix")) {
            tool.args.command = cmd.replace(/^npm\s+install\s+/, "npm install --prefix . ");
          }
        }
        if (tool.name === "write" && tool.args?.path) {
          const writePath = resolve(this._workspace, String(tool.args.path));
          const pathKey = String(tool.args.path);
          if (existsSync(writePath) && !this._lastToolIsRead && !this._autoReadDone.has(pathKey)) {
            const existing = readFileSync(writePath, "utf-8");
            this._messages.push({ role: "user", content: `---AUTO-READ: ${tool.args.path}---\n${existing.slice(0, 1500)}` });
            this._autoReadDone.add(pathKey);
          }
        }
        try { result = await t.execute(tool.args); }
        catch (err) { result = `Error: ${err.message}`; }
      }
      if (tool.name === "analyze" && !result.startsWith("Error:")) {
        this._lastAnalysis = result.slice(0, 1000);
      }
      yield { type: "tool-result", tool: tool.name, result };
      this._lastToolIsRead = ["read", "glob", "grep"].includes(tool.name);

      if (["read", "glob", "grep"].includes(tool.name)) {
        const filePath = tool.args?.path || tool.args?.pattern || "";
        const count = (this._readFiles.get(filePath) || 0) + 1;
        this._readFiles.set(filePath, count);
        if (count >= 3) {
          this._messages.push({
            role: "user",
            content: `You have read "${filePath}" ${count} times already. Stop reading. You have enough information. Call a tool to ACT now — edit, write, or bash. If you need to modify a file, use write with the full new content.`,
          });
          this._readFiles.clear();
          continue;
        }
      } else if (!["read", "glob", "grep"].includes(tool.name)) {
        this._readFiles.clear();
      }

      if (this._plan && this._plan.length > 0) {
        const failed = result.startsWith("Error") || result.startsWith("Syntax validation") || result.startsWith("Exit: -1");
        yield { type: "plan-update", index: this._planIndex, status: failed ? "failed" : "done" };
        this._planIndex++;
      }

      if (tool.name === "bash") {
        this._consecutiveBash++;
        if (this._consecutiveBash >= 3) {
          this._messages.push({
            role: "user",
            content: `STOP running bash commands. You have run ${this._consecutiveBash} in a row. You have enough information. Call the write tool now, or give the final answer. Do NOT run more bash commands.`,
          });
          this._consecutiveBash = 0;
          continue;
        }
        const cmd = String(tool.args?.command || "");
        const isRunCode = /^node\s+[^-]|^python[3]?\s+[^-]|^npm\s+start|^yarn\s+start|^pm2\s|^forever\s|^nodemon\s|^cargo\s+run|^mix\s+run/i.test(cmd);
        if (isRunCode && (result.includes("Timeout") || result.includes("Terminated") || /Exit:\s*-1/.test(result))) {
          yield { type: "answer", content: "All files are ready. To start the project, run in your terminal:\n\n```bash\ncd " + this._workspace + "\n" + cmd + "\n```" };
          return;
        }
        if (/^npm\s+install|^yarn\s+install|^pnpm\s+install/i.test(cmd) && !result.startsWith("Error")) {
          this._depsInstalled = true;
        }
      } else {
        this._consecutiveBash = 0;
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
      let msgContent = `---TOOL RESULT: ${tool.name}---\n${result.slice(0, 1500)}${result.length > 1500 ? "\n...(truncated)" : ""}${verifyExtra}`;

      if (tool.name === "write" && tool.args?.path) {
        const writtenPath = String(tool.args.path);
        if (writtenPath.endsWith("package.json") && !result.startsWith("Error") && !result.startsWith("Syntax validation")) {
          const pkgDir = resolve(this._workspace, writtenPath.replace(/\/package\.json$/, "").replace(/^package\.json$/, "."));
          const nodeModulesPath = resolve(pkgDir, "node_modules");
          if (!existsSync(nodeModulesPath)) {
            yield { type: "tool-call", tool: "bash", args: { command: "npm install", workdir: pkgDir } };
            try {
              await execAsync("npm install", { cwd: pkgDir, timeoutMs: 60000 });
              this._depsInstalled = true;
              msgContent += "\n\n[auto] Dependencies installed automatically.";
            } catch (e) {
              msgContent += "\n\n[auto] npm install failed — run it manually.";
            }
          } else {
            this._depsInstalled = true;
          }
        }
      }

      if (tool.name === "write") {
        this._consecutiveWrites++;
        if (this._consecutiveWrites >= 3) {
          const writtenPath = String(tool.args?.path || "the file");
          this._messages.push({
            role: "user",
            content: `You have written ${writtenPath} ${this._consecutiveWrites} times in a row. STOP writing. You are overwriting your own work. Give the final answer now. Do NOT write any more files.`,
          });
          yield { type: "answer", content: `Files written to ${this._workspace}. To run: cd ${this._workspace} && node server.js` };
          return;
        }
      } else {
        this._consecutiveWrites = 0;
      }
      this._messages.push({ role: "user", content: msgContent });

      const lastTwo = this._messages.slice(-2).map(m => m.content);
      const isRead = (n) => n === "read" || n === "glob" || n === "grep";
      if (isRead(tool.name) && lastTwo.length === 2 && /^---TOOL RESULT: (read|glob|grep)---/.test(lastTwo[1])) {
        this._messages.push({
          role: "user",
          content: "You already have the file contents. Do NOT respond with text. Call the next tool immediately — edit or write the file. If the user asked for changes, apply them now.",
        });
      }
    }
    yield { type: "error", content: `Maximum tool turns (${this._config.maxTurns}) reached before completion.` };
  }
}
