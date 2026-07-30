# MCP servers

KhazAI supports MCP servers over stdio and Streamable HTTP. Legacy HTTP+SSE
servers are not supported.

Trusted workspaces start the built-in `khazai-code` server automatically. It
provides read-only JavaScript, TypeScript, and Python code intelligence through
`project_overview`, `search_symbols`, `symbol_context`, `dependency_graph`, and
`impact_analysis`. Disable it for a workspace without affecting other servers:

```json
{
  "mcp": {
    "khazai-code": {
      "type": "builtin",
      "builtin": "code",
      "enabled": false
    }
  }
}
```

Configure servers in `~/.config/khazai-ai/config.json` or the workspace
`.khazai-ai.json` file:

```json
{
  "mcp": {
    "local-files": {
      "command": "npx",
      "args": ["-y", "@example/files-mcp"],
      "cwd": ".",
      "env": {
        "OPTIONAL_VALUE": "{env:OPTIONAL_VALUE}"
      },
      "tools": {
        "*": true,
        "dangerous_*": false
      },
      "discoveryTimeout": 5000,
      "callTimeout": 60000
    },
    "github": {
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer {auth}"
      }
    }
  }
}
```

KhazAI also imports MCP servers from OpenCode configuration automatically:
`~/.config/opencode/opencode.json{,c}` and `opencode.json{,c}` in the
workspace. KhazAI configuration takes precedence for duplicate server IDs.
OpenCode local-server fields (`command` arrays, `environment`, and `timeout`)
are supported.

Local `cwd` values must remain inside the trusted workspace. Non-loopback
remote servers must use HTTPS. Environment placeholders use `{env:NAME}`.
The `{auth}` placeholder uses the credential stored by `/mcp auth <server>`.

Available commands:

- `/mcp` opens the interactive server manager.
- `/mcp list` lists configured servers.
- `/mcp add` opens the stdio or Streamable HTTP setup wizard.
- `/mcp remove <server>` disconnects and removes a server after confirmation.
- `/mcp status [server]` shows connection state and capabilities.
- `/mcp connect <server>` and `/mcp disconnect <server>` control one connection.
- `/mcp enable <server>` and `/mcp disable <server>` control automatic startup.
- `/mcp tools [server]`, `/mcp resources [server]`, and `/mcp prompts [server]`
  show discovered capabilities.
- `/mcp reload` rereads configuration and refreshes native tool registrations.
- `/mcp auth <server>` stores a remote server credential securely.
- `/mcp logout <server>` removes the stored credential.

Discovered tools use stable native names such as `mcp__github__create_issue`.
Every MCP tool requires interactive approval by default. Permission patterns
can be configured normally:

```json
{
  "permission": {
    "mcp__github__*": "ask",
    "mcp__github__list_*": "allow",
    "mcp__github__delete_*": "deny"
  }
}
```
