import { createElement as h } from "react";
import { render } from "ink";
import { useState } from "react";
import { TrustPrompt } from "./components/trust-prompt.js";
import { Session } from "./session.js";
import { createScrollbackOutput, prepareScrollableTerminal } from "./scrollback-output.js";
import { getWorkspace, markTrusted } from "../config/workspace.js";

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

  return h(Session, { workspace: getWorkspace() });
}

export async function startUI() {
  prepareScrollableTerminal(process.stdout);
  const stdout = createScrollbackOutput(process.stdout);
  await render(h(App), { stdout }).waitUntilExit();
}
