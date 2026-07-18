import { createElement as h } from "react";
import { Box, render, Text } from "ink";
import { useEffect, useState } from "react";
import { TrustPrompt } from "./components/trust-prompt.js";
import { Session } from "./session.js";
import { createScrollbackOutput, prepareScrollableTerminal } from "./scrollback-output.js";
import { getWorkspace, markTrusted } from "../config/workspace.js";
import { shutdownAllLsp } from "../app/lsp.js";
import { getMcpManager, shutdownAllMcp } from "../app/mcp.js";
import { shutdownWebSearch } from "../tools/websearch.js";

function TrustedSession({ workspace }) {
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
  });
}

function App() {
  const [ws] = useState(() => getWorkspace());
  const [trusted, setTrusted] = useState(ws.trusted);

  if (!trusted) {
    return h(TrustPrompt, {
      path: ws.path,
      onTrust: () => {
        markTrusted(ws.cfgPath);
        setTrusted(true);
      },
    });
  }

  return h(TrustedSession, { workspace: { ...ws, trusted: true } });
}

export async function startUI() {
  prepareScrollableTerminal(process.stdout);
  const stdout = createScrollbackOutput(process.stdout);
  try {
    await render(h(App), { stdout }).waitUntilExit();
  } finally {
    await Promise.all([shutdownAllLsp(), shutdownAllMcp(), shutdownWebSearch()]);
  }
}
