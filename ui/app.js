import { createElement as h } from "react";
import { render } from "ink";
import { useState } from "react";
import { TrustPrompt } from "./components/trust-prompt.js";
import { Session } from "./session.js";
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

export function startUI() {
  return render(h(App)).waitUntilExit();
}
