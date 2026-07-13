import { createElement as h, Fragment } from "react";
import { useState, useRef, useCallback } from "react";
import { Box, Static } from "ink";
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
import { repoTool } from "../tools/repo.js";
import { Banner } from "./components/banner.js";
import { MessageList } from "./components/message-list.js";
import { PlanList } from "./components/plan-list.js";
import { SessionFooter } from "./components/session-footer.js";
import { EmptyState } from "./components/empty-state.js";
import { normalizeVerticalWhitespace } from "./text-layout.js";
import { classifyToolState } from "./tool-presentation.js";
import { removeEmoji } from "../lib/assistant-text.js";

function buildRegistry() {
  const r = new Registry();
  for (const t of [readTool, writeTool, editTool, globTool, grepTool, bashTool, analyzeTool, webTool, webSearchTool, repoTool, questionTool, taskTool]) r.register(t);
  return r;
}

let msgId = 0;
function nextId() { return `m${++msgId}`; }

export function normalizeStreamText(text) {
  return normalizeVerticalWhitespace(removeEmoji(text));
}

export function toolResultFailed(result) {
  return classifyToolState(result, true) === "failed";
}

export function formatInteractiveQuestion(question, options = []) {
  const lines = [removeEmoji(question).trim()];
  options.filter(Boolean).forEach((option, index) => lines.push(`${index + 1}. ${removeEmoji(option)}`));
  return lines.filter(Boolean).join("\n");
}

export function Session({ workspace }) {
  const [completedMessages, setCompletedMessages] = useState([]);
  const [activeMessage, setActiveMessage] = useState(null);
  const [plan, setPlan] = useState([]);
  const [running, setRunning] = useState(false);
  const [currentModel, setCurrentModel] = useState(loadConfig().model);
  const [sessionKey, setSessionKey] = useState(0);
  const [pendingQuestion, setPendingQuestion] = useState(null);
  const [expandedTool, setExpandedTool] = useState(null);
  const agentRef = useRef(null);
  const activeRef = useRef(null);
  const toolStartRef = useRef(null);
  const submittingRef = useRef(false);
  const questionResolverRef = useRef(null);
  const streamBufferRef = useRef("");
  const streamTimerRef = useRef(null);
  const completedRef = useRef([]);

  if (!agentRef.current) {
    agentRef.current = new Agent(buildRegistry(), { workspace: workspace.path });
  }

  const appendCompleted = useCallback(message => {
    const next = [...completedRef.current, message];
    completedRef.current = next;
    setCompletedMessages(next);
    return next;
  }, []);

  const appendArchived = useCallback(message => {
    return appendCompleted(message);
  }, [appendCompleted]);

  const handleCommand = useCallback((cmd, arg) => {
    if (cmd === "/exit") process.exit(0);
    if (cmd === "/model" && arg) {
      saveModel(arg);
      process.stdout.write("\u001b[2J\u001b[H");
      setCurrentModel(arg);
      agentRef.current = new Agent(buildRegistry(), { workspace: workspace.path, model: arg });
      activeRef.current = null;
      completedRef.current = [];
      setCompletedMessages([]);
      setActiveMessage(null);
      setPlan([]);
      setExpandedTool(null);
      setSessionKey(key => key + 1);
    }
    if (cmd === "/theme" && arg) {
      appendArchived({ id: nextId(), type: "answer", content: `Theme changed to **${arg}**. Restart to apply.` });
    }
    if (cmd === "/help") {
      const list = COMMANDS.map(c => `\`${c.name}\` — ${c.description}`).join("\n");
      appendArchived({ id: nextId(), type: "answer", content: `**Commands:**\n${list}` });
    }
    if (cmd === "/expand") {
      const latest = completedRef.current.findLast(message => message.type === "tool");
      setExpandedTool(latest ? { ...latest, id: `expanded-${latest.id}`, expanded: true } : null);
    }
    if (cmd === "/collapse") setExpandedTool(null);
  }, [appendArchived, workspace.path]);

  const submit = useCallback(async (input) => {
    // React state updates are asynchronous; the ref closes the gap before the
    // disabled prop is rendered and prevents two loops mutating one Agent.
    if (!input.trim() || submittingRef.current) return;
    setExpandedTool(null);
    submittingRef.current = true;
    const startedAt = Date.now();
    setRunning(true);
    let taskTools = 0;
    let filesCreated = 0;
    let filesUpdated = 0;
    let testsPassed = 0;
    let succeeded = false;
    const activate = message => {
      activeRef.current = message;
      setActiveMessage(message);
    };
    const clearActive = () => {
      activeRef.current = null;
      setActiveMessage(null);
    };
    const flushStream = () => {
      if (streamTimerRef.current) {
        clearTimeout(streamTimerRef.current);
        streamTimerRef.current = null;
      }
      const buffered = streamBufferRef.current;
      streamBufferRef.current = "";
      const current = activeRef.current;
      if (!buffered || current?.type !== "streaming") return;
      const next = { ...current, content: normalizeStreamText(current.content + buffered) };
      activeRef.current = next;
      setActiveMessage(next);
    };
    const completeStreaming = () => {
      flushStream();
      const current = activeRef.current;
      if (current?.type === "streaming") {
        clearActive();
        appendArchived({ id: nextId(), type: "answer", content: current.content });
        return true;
      }
      return false;
    };

    appendArchived({ id: nextId(), type: "user", content: input });

    const agent = agentRef.current;
    agent.setQuestionHandler(() => new Promise(resolve => {
      questionResolverRef.current = resolve;
    }));
    try {
    for await (const ev of agent.loop(input)) {
      if (ev.type === "thinking") {
        continue;
      }

      if (ev.type === "plan") {
        completeStreaming();
        clearActive();
        setPlan(ev.items.map(item => ({ ...item, status: "pending" })));
        continue;
      }

      if (ev.type === "plan-update") {
        setPlan(prev => prev.map((item, i) =>
          i === ev.index ? { ...item, status: ev.status } : item
        ));
        continue;
      }

      if (ev.type === "question") {
        const questionAlreadyStreamed = completeStreaming();
        clearActive();
        if (!questionAlreadyStreamed) {
          appendArchived({
            id: nextId(),
            type: "answer",
            content: formatInteractiveQuestion(ev.question, ev.options),
          });
        }
        setPendingQuestion({ question: ev.question, options: ev.options });
        continue;
      }

      if (ev.type === "tool-call") {
        completeStreaming();
        toolStartRef.current = Date.now();
        activate({ id: nextId(), type: "tool", tool: ev.tool, args: ev.args, done: false });
        continue;
      }

      if (ev.type === "stream") {
        const current = activeRef.current;
        if (current?.type === "streaming") {
          streamBufferRef.current += ev.token;
          if (!streamTimerRef.current) {
            streamTimerRef.current = setTimeout(() => flushStream(), 40);
          }
        } else {
          const initial = normalizeStreamText(ev.token);
          if (!initial) continue;
          clearActive();
          activate({ id: nextId(), type: "streaming", content: initial });
        }
        continue;
      }

      if (ev.type === "tool-result") {
        flushStream();
        const current = activeRef.current;
        const duration = toolStartRef.current ? Date.now() - toolStartRef.current : null;
        const resultSize = Buffer.byteLength(ev.result || "");
        const failed = toolResultFailed(ev.result);
        taskTools++;
        if (ev.tool === "write" && /^Written /.test(ev.result)) filesCreated++;
        if (ev.tool === "edit" && /^Edited /.test(ev.result)) filesUpdated++;
        const testMatch = /Ran\s+(\d+)\s+tests?|\b(\d+)\s+passed\b/i.exec(ev.result);
        if (testMatch) testsPassed = Math.max(testsPassed, Number(testMatch[1] || testMatch[2]));
        clearActive();
        appendArchived(
          current?.type === "tool"
            ? { ...current, content: ev.result, done: true, failed, duration, resultSize, expanded: false }
            : { id: nextId(), type: "tool", tool: ev.tool, args: {}, content: ev.result, done: true, failed, duration, resultSize, expanded: false }
        );
        continue;
      }

      if (ev.type === "answer" || ev.type === "error") {
        completeStreaming();
        if (ev.type === "answer") succeeded = true;
        appendArchived({ id: nextId(), type: ev.type, content: removeEmoji(ev.content) });
        continue;
      }

      if (ev.type === "stream-end") {
        flushStream();
        const current = activeRef.current;
        if (current?.type === "streaming") {
          clearActive();
          appendArchived({ id: nextId(), type: "answer", content: current.content });
        }
        succeeded = true;
        continue;
      }
    }
    } catch (error) {
      clearActive();
      appendArchived({ id: nextId(), type: "error", content: `Unexpected session error: ${error.message}` });
    } finally {
      flushStream();
      clearActive();
      questionResolverRef.current = null;
      setPendingQuestion(null);
      submittingRef.current = false;
      setRunning(false);
      if (succeeded && taskTools > 0) {
        appendArchived({
          id: nextId(), type: "summary", tools: taskTools,
          created: filesCreated, updated: filesUpdated, tests: testsPassed,
          duration: Date.now() - startedAt,
        });
      }
    }
  }, [appendArchived]);

  const answerQuestion = useCallback(answer => {
    const resolve = questionResolverRef.current;
    const value = String(answer || "").trim();
    if (!resolve || !value) return;
    questionResolverRef.current = null;
    setPendingQuestion(null);
    appendArchived({ id: nextId(), type: "user", content: value });
    resolve(value);
  }, [appendArchived]);

  const clearDisplay = useCallback(() => {
    process.stdout.write("\u001b[2J\u001b[H");
    completedRef.current = [];
    activeRef.current = null;
    setCompletedMessages([]);
    setActiveMessage(null);
    setPlan([]);
    setExpandedTool(null);
    setSessionKey(key => key + 1);
  }, []);

  const staticItems = [
    { id: `banner-${sessionKey}`, type: "banner" },
    ...completedMessages,
  ];

  return h(Fragment, null,
    h(Static, {
      key: `history-${sessionKey}`,
      items: staticItems,
    }, item => item.type === "banner"
      ? h(Banner, {
          key: item.id,
          model: currentModel,
          workspace: workspace.path,
        })
      : h(MessageList, { key: item.id, messages: [item] })),
    h(Box, { flexDirection: "column", width: "100%" },
      activeMessage
        ? h(MessageList, {
            messages: [activeMessage],
            previousType: completedMessages.at(-1)?.type || null,
        })
        : null,
      expandedTool && !running
        ? h(MessageList, { messages: [expandedTool] })
        : null,
      completedMessages.length === 0 && !activeMessage && !pendingQuestion && plan.length === 0
        ? h(EmptyState)
        : null,
      h(PlanList, { plan }),
      h(SessionFooter, {
        running,
        plan,
        waitingForAnswer: Boolean(pendingQuestion),
        promptProps: {
          onSubmit: pendingQuestion ? answerQuestion : submit,
          onCommand: handleCommand,
          onClear: clearDisplay,
          commands: COMMANDS,
          disabled: running && !pendingQuestion,
          activeModel: currentModel,
        },
      }),
    ),
  );
}
