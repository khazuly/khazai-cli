import { createElement as h } from "react";
import { Box, Static } from "ink";
import { useState, useRef, useCallback } from "react";
import { Agent } from "../app/agent.js";
import { Registry } from "../app/registry.js";
import { loadConfig, saveModel } from "../config/index.js";
import { COMMANDS } from "./commands.js";
import { readTool, writeTool, editTool } from "../tools/file.js";
import { globTool, grepTool } from "../tools/search.js";
import { bashTool } from "../tools/shell.js";
import { analyzeTool } from "../tools/analyze.js";
import { webTool } from "../tools/web.js";
import { webSearchTool } from "../tools/websearch.js";
import { questionTool } from "../tools/question.js";
import { taskTool } from "../tools/task.js";
import { Banner } from "./components/banner.js";
import { MessageList } from "./components/message-list.js";
import { PromptInput } from "./components/prompt-input.js";
import { PlanList } from "./components/plan-list.js";

function buildRegistry() {
  const r = new Registry();
  for (const t of [readTool, writeTool, editTool, globTool, grepTool, bashTool, analyzeTool, webTool, webSearchTool, questionTool, taskTool]) r.register(t);
  return r;
}

let msgId = 0;
function nextId() { return `m${++msgId}`; }

export function Session({ workspace }) {
  const [completedMessages, setCompletedMessages] = useState([]);
  const [activeMessage, setActiveMessage] = useState(null);
  const [plan, setPlan] = useState([]);
  const [running, setRunning] = useState(false);
  const [currentModel, setCurrentModel] = useState(loadConfig().model);
  const [sessionKey, setSessionKey] = useState(0);
  const agentRef = useRef(null);
  const activeRef = useRef(null);

  if (!agentRef.current) {
    agentRef.current = new Agent(buildRegistry(), { workspace: workspace.path });
  }

  const appendCompleted = useCallback(message => {
    setCompletedMessages(previous => [...previous, message]);
  }, []);

  const handleCommand = useCallback((cmd, arg) => {
    if (cmd === "/exit") process.exit(0);
    if (cmd === "/model" && arg) {
      saveModel(arg);
      process.stdout.write("\x1bc");
      setCurrentModel(arg);
      agentRef.current = new Agent(buildRegistry(), { workspace: workspace.path, model: arg });
      activeRef.current = null;
      setCompletedMessages([]);
      setActiveMessage(null);
      setPlan([]);
      setSessionKey(key => key + 1);
    }
    if (cmd === "/help") {
      const list = COMMANDS.map(c => `\`${c.name}\` — ${c.description}`).join("\n");
      appendCompleted({ id: nextId(), type: "system", content: `**Commands:**\n${list}` });
    }
  }, [appendCompleted, workspace.path]);

  const submit = useCallback(async (input) => {
    if (!input.trim() || running) return;
    setRunning(true);
    const activate = message => {
      activeRef.current = message;
      setActiveMessage(message);
    };
    const clearActive = () => {
      activeRef.current = null;
      setActiveMessage(null);
    };

    appendCompleted({ id: nextId(), type: "user", content: input });

    const agent = agentRef.current;
    for await (const ev of agent.loop(input)) {
      if (ev.type === "thinking") {
        if (activeRef.current?.type !== "thinking") {
          activate({ id: nextId(), type: "thinking" });
        }
        continue;
      }

      if (ev.type === "plan") {
        setPlan(ev.items.map(item => ({ ...item, status: "pending" })));
        continue;
      }

      if (ev.type === "plan-update") {
        setPlan(prev => prev.map((item, i) =>
          i === ev.index ? { ...item, status: ev.status } : item
        ));
        continue;
      }

      if (ev.type === "tool-call") {
        activate({ id: nextId(), type: "tool", tool: ev.tool, args: ev.args, done: false });
        continue;
      }

      if (ev.type === "tool-result") {
        const current = activeRef.current;
        clearActive();
        appendCompleted(
          current?.type === "tool"
            ? { ...current, content: ev.result.slice(0, 300), done: true }
            : { id: nextId(), type: "tool", tool: ev.tool, args: {}, content: ev.result.slice(0, 300), done: true }
        );
        continue;
      }

      if (ev.type === "answer" || ev.type === "error") {
        clearActive();
        appendCompleted({ id: nextId(), type: ev.type, content: ev.content });
      }
    }
    clearActive();
    setRunning(false);
  }, [running]);

  return h(Box, { flexDirection: "column" },
    h(Static, { key: sessionKey, items: [{ type: "banner" }, ...completedMessages] }, (item, index) => {
      if (item.type === "banner") {
        return h(Banner, {
          key: "banner",
          version: "0.2.0",
          model: currentModel,
          workspace: workspace.path,
        });
      }
      return h(Box, {
        key: item.id,
        marginTop: index === 1 ? 1 : 0,
      },
        h(MessageList, {
          messages: [item],
          previousType: completedMessages[index - 2]?.type || null,
        })
      );
    }),
    h(Box, { flexDirection: "column", marginTop: 1 },
      activeMessage
        ? h(MessageList, {
            messages: [activeMessage],
            previousType: completedMessages.at(-1)?.type || null,
          })
        : null,
      h(PlanList, { plan }),
      h(PromptInput, { onSubmit: submit, onCommand: handleCommand, commands: COMMANDS, disabled: running, activeModel: currentModel })
    )
  );
}
