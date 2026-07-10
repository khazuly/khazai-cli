import { createElement as h } from "react";
import { Text, Box } from "ink";
import { useState, useRef, useCallback } from "react";
import { Agent } from "../app/agent.js";
import { Registry } from "../app/registry.js";
import { loadConfig } from "../config/index.js";
import { readTool, writeTool, editTool } from "../tools/file.js";
import { globTool, grepTool } from "../tools/search.js";
import { bashTool } from "../tools/shell.js";
import { webTool } from "../tools/web.js";
import { questionTool } from "../tools/question.js";
import { taskTool } from "../tools/task.js";
import { Banner } from "./components/banner.js";
import { MessageList } from "./components/message-list.js";
import { PromptInput } from "./components/prompt-input.js";

function buildRegistry() {
  const r = new Registry();
  for (const t of [readTool, writeTool, editTool, globTool, grepTool, bashTool, webTool, questionTool, taskTool]) r.register(t);
  return r;
}

let msgId = 0;
function nextId() { return `m${++msgId}`; }

export function Session({ workspace }) {
  const [messages, setMessages] = useState([]);
  const [running, setRunning] = useState(false);
  const config = useRef(loadConfig());
  const agentRef = useRef(null);

  if (!agentRef.current) {
    agentRef.current = new Agent(buildRegistry(), { workspace: workspace.path });
  }

  const submit = useCallback(async (input) => {
    if (!input.trim() || running) return;
    setRunning(true);

    setMessages(prev => [...prev, { id: nextId(), type: "user", content: input }]);

    const agent = agentRef.current;
    for await (const ev of agent.loop(input)) {
      setMessages(prev => {
        if (ev.type === "thinking") {
          if (prev.some(m => m.type === "thinking")) return prev;
          return [...prev, { id: nextId(), type: "thinking" }];
        }

        const filtered = prev.filter(m => m.type !== "thinking");

        if (ev.type === "tool-call") {
          return [...filtered, { id: nextId(), type: "tool", tool: ev.tool, args: ev.args, done: false }];
        }
        if (ev.type === "tool-result") {
          return filtered.map(m =>
            m.type === "tool" && m.tool === ev.tool && !m.done
              ? { ...m, content: ev.result.slice(0, 300), done: true }
              : m
          );
        }
        if (ev.type === "answer") {
          return [...filtered, { id: nextId(), type: "answer", content: ev.content }];
        }
        if (ev.type === "error") {
          return [...filtered, { id: nextId(), type: "error", content: ev.content }];
        }
        return prev;
      });
    }
    setRunning(false);
  }, [running]);

  return h(Box, { flexDirection: "column" },
    h(Banner, { version: "0.2.0", model: config.current.model, workspace: workspace.path }),
    h(Box, { flexDirection: "column", marginTop: 1 },
      h(MessageList, { messages })
    ),
    h(PromptInput, { onSubmit: submit, disabled: running })
  );
}
