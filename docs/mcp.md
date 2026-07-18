# MCP servers

KhazAI supports MCP servers over stdio and Streamable HTTP. Legacy HTTP+SSE
servers are not supported.

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

Local `cwd` values must remain inside the trusted workspace. Non-loopback
remote servers must use HTTPS. Environment placeholders use `{env:NAME}`.
The `{auth}` placeholder uses the credential stored by `/mcp auth <server>`.

Available commands:

- `/mcp` or `/mcp status` lists server state and discovered tool counts.
- `/mcp refresh` reconnects servers and refreshes native tool schemas.
- `/mcp auth <server>` stores a remote server credential securely.
- `/mcp logout <server>` removes the stored credential.

Discovered tools use stable native names such as `mcp_github_create_issue`.
Every MCP tool requires interactive approval by default. Permission patterns
can be configured normally:

```json
{
  "permission": {
    "mcp_github_*": "ask",
    "mcp_github_list_*": "allow",
    "mcp_github_delete_*": "deny"
  }
}
```
