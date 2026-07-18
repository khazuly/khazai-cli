# Tool runtime

KhazAI exposes an OpenCode-style coding-agent runtime:

- `read`, `glob`, and `grep` inspect local code.
- `write` and `edit` modify files.
- `bash` runs shell commands in the active workspace.
- `webfetch` reads one HTTP(S) resource.
- `websearch` searches the web.
- `question`, `task`, and configured MCP tools provide interactive,
  sub-agent, and extension support.
- `todowrite` updates the structured plan shown by the CLI.

All calls use one executor pipeline for normalization, schema validation,
permissions, lifecycle transitions, hooks, execution, redaction, truncation,
and persistence. Independent read-only calls run concurrently. State-changing
calls from the same provider response run sequentially in their original order
without asking the model to reissue them.

The model may return up to eight native tool calls at once. Read-only calls run
concurrently, with four workers by default. Mutating calls always run
sequentially. Native call IDs are preserved through pending, running, completed,
and error states. Each model step also records a finish part and, in Git
worktrees, a snapshot and the set of files changed during the step.

Tool execution supports ordered `tool.definition`, `tool.execute.before`, and
`tool.execute.after` hooks. Provider history uses native assistant tool calls and tool-result
messages when the provider supports the OpenAI-compatible tool protocol.

Custom tools are discovered from `.opencode/{tool,tools}` and
`.khazai/{tool,tools}`, plus their global configuration equivalents. JavaScript
and TypeScript modules may use the OpenCode `{ description, args, execute }`
shape; TypeScript is bundled into the KhazAI cache. KhazAI paths take
precedence over compatibility paths at the same scope. Local plugins in
`{plugin,plugins}` directories may contribute tools and the three runtime
hooks.

The primary model is called directly without intent classification or semantic
tool routing. Tool schemas are available without a prompt-level mapping that
forces a particular tool for reads, edits, searches, or URL inspection. Native provider streams emit typed
text, reasoning, tool-call, finish, and error events. Text reaches the UI after
one 32-character identity sanitizer holdback, while native tool-call deltas
remain structured and hidden from prose.

Tool definitions are sent once through the provider's native `tools` field.
They are not duplicated as JSON schema text in the system prompt. Run
`npm run benchmark:latency` to measure local dispatch and first-text overhead;
`KHAZAI_DEBUG=1` prints dispatch, provider-first-delta, UI-first-text, and
completion timing for real turns.

The Big Pickle system prompt is a KhazAI-branded behavioral adaptation of
OpenCode's default prompt from release 1.17.20. Provider/model, working
directory, worktree, Git status, project instructions, active agent profile,
and permitted skill summaries are composed dynamically. Permissions and tool
boundaries remain enforced in code without changing the model's tool choice.

## Terminal interaction

KhazAI keeps native terminal scrollback so conversation history remains
copy-friendly. The header shows model, workspace, agent, and approval mode;
active status and completion receipts are derived from real tool lifecycle
state.

- Prefix input with `!` to execute one shell command through the normal Bash
  tool, permission, lifecycle, redaction, and presentation pipeline.
- Type `@` to fuzzy-filter workspace files. Selected text files are attached to
  the model request with workspace-boundary, binary-file, count, and size limits.
- Use `/theme system|dark|light|mono` to apply and persist a theme immediately.
  `NO_COLOR` always selects monochrome presentation.
- Completion receipts list recorded files and validation commands. A workspace
  mutation without a validation command is shown as `Check not run`.

## Permissions

Configure permissions globally in
`~/.config/khazai-ai/config.json` or per workspace in `.khazai-ai.json`:

```json
{
  "permission": {
    "read": "allow",
    "edit": "ask",
    "bash": {
      "git status*": "allow",
      "*": "ask"
    },
    "external_directory": "ask"
  }
}
```

The `edit` permission covers `write` and `edit`. Existing
`write` permission settings are migrated as an `edit` rule when no explicit
`edit` rule exists. An outside path requires `external_directory` approval in
addition to the tool's own permission.

Rules use last-match-wins ordering across defaults, global configuration,
workspace configuration, agent configuration, and session approvals. Defaults
allow tools, ask for `external_directory`, deny `.env` reads, and allow
`.env.example`. Selecting `Always allow` creates a session rule. `--auto` or
`/auto` turns asks into allows but never overrides an explicit deny.

## Completion and recovery

Tool failures and malformed calls are stored as structured error parts and sent
back to the model as tool errors. KhazAI does not require a locally inferred
set of semantic evidence before accepting the model's final response. Hard
invariants remain enforced by code: permission denies, workspace boundaries,
credential redaction, argument validation, and process cleanup. Repeated calls
remain model-controlled; cancellation and the overall turn limit are the
non-interactive circuit breakers.

Older sessions are migrated idempotently to version 4 when loaded. Migration
keeps visible conversation and native tool history while removing legacy
intent, evidence, pending-recovery, and internal-steering state.

## Web configuration

`webfetch` follows at most five redirects, rejects credentials and metadata
endpoints, and blocks private or loopback targets by both literal address and
DNS resolution. Responses are capped, cached briefly, and paginated with
`offset` and `limit`.

`websearch` uses this default provider order:

1. Exa hosted MCP
2. Brave, Tavily, or Serper when the corresponding environment key exists
3. local search-page fallbacks

Override the order explicitly:

```json
{
  "web": {
    "allowPrivate": false,
    "search": {
      "providers": ["exa", "brave", "tavily", "serper", "local"]
    }
  },
  "toolConcurrency": 4
}
```

Optional credentials are read from `BRAVE_API_KEY`, `TAVILY_API_KEY`, and
`SERPER_API_KEY`.
