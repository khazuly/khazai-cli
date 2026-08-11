import { createElement as h } from "react";
import { Box, render, Text, useApp } from "ink";
import { useEffect, useState } from "react";
import { existsSync } from "node:fs";
import { TrustPrompt } from "./components/trust-prompt.js";
import { Session } from "./session.js";
import { prepareScrollableTerminal } from "./scrollback-output.js";
import { getWorkspace, markTrusted } from "../config/workspace.js";
import { shutdownAllLsp } from "../app/lsp.js";
import { getMcpManager, shutdownAllMcp } from "../app/mcp.js";
import { shutdownWebSearch } from "../tools/websearch.js";
import { createTerminalTitle } from "./terminal-title.js";

function TrustedSession({ workspace, terminalTitle }) {
  const [ready, setReady] = useState(null);

  useEffect(() => {
    let active = true;
    const manager = getMcpManager(workspace.path);
    manager.refresh()
      .then(tools => { if (active) setReady({ manager, tools }); })
      .catch(() => { if (active) setReady({ manager, tools: [] }); });
    return () => { active = false; };
  }, [workspace.path]);

  if (!ready) {
    return h(Box, { padding: 1 }, h(Text, null, "Connecting configured MCP servers..."));
  }
  return h(Session, {
    workspace,
    mcpManager: ready.manager,
    initialMcpTools: ready.tools,
    terminalTitle,
  });
}

function MissingDir({ path }) {
  const { exit } = useApp();
  useEffect(() => { exit(); }, []);
  return h(Box, {
    flexDirection: "column",
    borderStyle: "round",
    borderColor: "red",
    paddingX: 2,
    paddingY: 1,
    marginLeft: 1,
    marginRight: 1,
    marginTop: 1,
  },
    h(Text, { bold: true, color: "red" }, "Error"),
    h(Text, {}, `Directory not found: ${path}`),
  );
}

function App({ terminalTitle, initialWorkspace }) {
  const [ws] = useState(() => initialWorkspace || getWorkspace());
  const [trusted, setTrusted] = useState(ws.trusted);

  if (!existsSync(ws.path)) {
    return h(MissingDir, { path: ws.path });
  }

  if (!trusted) {
    return h(TrustPrompt, {
      path: ws.path,
      onTrust: () => {
        markTrusted(ws.cfgPath);
        setTrusted(true);
      },
    });
  }

  return h(TrustedSession, { workspace: { ...ws, trusted: true }, terminalTitle });
}

export async function startUI() {
  const workspace = getWorkspace();
  const terminalTitle = createTerminalTitle({ workspacePath: workspace.path });
  prepareScrollableTerminal(process.stdout);
  try {
    await render(h(App, { terminalTitle, initialWorkspace: workspace }), { stdout: process.stdout }).waitUntilExit();
  } finally {
    terminalTitle.dispose();
    await Promise.all([shutdownAllLsp(), shutdownAllMcp(), shutdownWebSearch()]);
  }
}
