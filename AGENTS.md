# AGENTS.md — Rules for AI Assistant (khazai-cli)

> **READ THIS FIRST before every update. Non-negotiable.**

---

## Core Principle

**LLM is unreliable at following instructions. Enforce behavior at code level, not prompts.**

- Prompt = hope
- Code = reality

**NEVER:**
- Add more rules to system prompt hoping LLM will follow
- Say "do NOT do X" in prompt and expect compliance
- Make the prompt longer to fix a behavioral issue

**ALWAYS:**
- Add a guard in the tool/agent code
- Auto-handle at agent level
- Post-process the output in code

---

## Architecture

```
khazai-cli/
├── app/agent.js      — Agent loop (orchestrates LLM + tools)
├── app/registry.js   — Tool registry
├── lib/llm.js        — LLM calls (SSE streaming via aichat.org)
├── lib/exec-async.js — Shell execution with process group kill
├── tools/
│   ├── file.js       — read, write, edit tools
│   ├── shell.js      — bash tool
│   ├── search.js     — glob, grep tools
│   ├── analyze.js    — code analysis
│   ├── web.js        — URL fetching
│   ├── websearch.js  — web search
│   ├── question.js   — ask user
│   └── task.js       — sub-agent
├── ui/               — Ink UI (status-bar, message-list, etc.)
├── config/           — workspace, settings
└── bin/              — CLI entry point
```

---

## Tool-Level Guards (Implemented)

| Guard | Location | What it does |
|-------|----------|--------------|
| Server blocking | `tools/shell.js` | `BLOCKED` if command is `node server`, `npm start`, `python http.server` |
| node_modules check | `app/agent.js` | Auto-check `ls -d node_modules` before `npm install` |
| Auto npm install | `app/agent.js` | After writing `package.json`, auto-run `npm install` |
| Write-before-read | `app/agent.js` | If file exists, auto-read before write |
| Auto workdir | `app/agent.js` | Auto-set `workdir` to workspace for bash commands |
| Answer cleaning | `app/agent.js` | Remove code block formatting from LLM answers |
| Tool JSON suppress | `app/agent.js` | Hide JSON tool calls during streaming |

---

## How to Add New Features

### If LLM is not doing something it should:
1. **DON'T** add "ALWAYS do X" to system prompt
2. **DO** add auto-handling in agent loop (before/after tool execution)

### If LLM is doing something it shouldn't:
1. **DON'T** add "NEVER do X" to system prompt
2. **DO** add block/restriction in the tool code itself

### If LLM output is messy:
1. **DON'T** tell LLM "keep answers concise"
2. **DO** post-process the answer in `_cleanAnswer()` or similar

---

## Common Mistakes to Avoid

1. **Prompt bloat** — Every rule you add to prompt makes it longer and less effective
2. **Contradictory rules** — Don't say "NEVER run python3 -m http.server" AND "Single .html → python3 -m http.server"
3. **Relying on LLM for critical logic** — npm install, file detection, etc. should be automated
4. **Ignoring tool execution context** — Always set `workdir` for bash, always check file existence before write
5. **Forgetting process cleanup** — Use `detached: true` + process group kill for background processes

---

## Model Notes

- **GPT-4o-mini**: Faster (30s), more compliant, cheaper
- **Claude Haiku**: Slower (125s), less compliant, more expensive
- Default: `gpt` → `openai/gpt-4o-mini`
- Model shortcuts: `gpt`, `claude`, `gemini` in `config/defaults.js`

---

## Git Rules

- Commit only when user explicitly asks
- Don't commit secrets (.git-credentials was leaked before — squashed to remove)
- Don't commit secrets (check .gitignore before commit)
- Workspace config: `~/.config/khazai-ai/workspaces/`

---

## Testing

Test with script, NOT interactive CLI:
```bash
timeout 90 node -e "
import { Agent } from './app/agent.js';
import { Registry } from './app/registry.js';
import { readTool, writeTool, editTool } from './tools/file.js';
import { globTool, grepTool } from './tools/search.js';
import { bashTool } from './tools/shell.js';
import { analyzeTool } from './tools/analyze.js';
import { webTool } from './tools/web.js';
import { webSearchTool } from './tools/websearch.js';
import { questionTool } from './tools/question.js';
import { taskTool } from './tools/task.js';

const r = new Registry();
for (const t of [readTool, writeTool, editTool, globTool, grepTool, bashTool, analyzeTool, webTool, webSearchTool, questionTool, taskTool]) r.register(t);
const agent = new Agent(r, { model: 'gpt', workspace: '/public/landing-page' });

let toolCalls = 0;
for await (const ev of agent.loop('YOUR_PROMPT_HERE')) {
  if (ev.type === 'tool-call') { toolCalls++; console.error('TOOL#' + toolCalls + ':', ev.tool); }
  if (ev.type === 'answer') { console.log(ev.content); break; }
  if (toolCalls > 15) break;
}
"
```

---

## Version History

- v0.1.0: Basic agent with tools
- v0.2.0: UI improvements (banner, status-bar, spinners)
- v0.3.0: Streaming, tool execution fixes
- v0.3.1: Tool-level guards (this version)

---

## TL;DR

**Stop writing prompts. Start writing guards.**
