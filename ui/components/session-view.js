import { createElement as h } from "react";
import { Box, Static } from "ink";
import { COMMANDS } from "../commands.js";
import { ThemeProvider } from "../theme.js";
import { Banner } from "./banner.js";
import { EmptyState } from "./empty-state.js";
import { MessageList } from "./message-list.js";
import { PlanList } from "./plan-list.js";
import { SessionFooter } from "./session-footer.js";
import { ToolDetailInspector } from "./tool-detail-inspector.js";

export function SessionView({
  activeMessage,
  agent,
  autoApprove,
  completedMessages,
  currentModel,
  handlers,
  inspectedTool,
  pendingQuestion,
  plan,
  running,
  runningStartedAt,
  sessionKey,
  themeName,
  workspaceFiles,
  workspacePath,
}) {
  const staticItems = [
    { id: `banner-${sessionKey}`, type: "banner" },
    ...completedMessages,
  ];
  const displayedActiveMessage = activeMessage?.type === "streaming" ? null : activeMessage;

  return h(ThemeProvider, { name: themeName }, h(Box, {
    flexDirection: "column",
    width: "100%",
    paddingLeft: 1,
  },
    h(Static, {
      key: `history-${sessionKey}`,
      items: staticItems,
    }, item => item.type === "banner"
      ? h(Banner, {
          key: item.id,
          model: currentModel,
          workspace: workspacePath,
          agent,
          autoApprove,
        })
      : h(MessageList, { key: item.id, messages: [item] })),
    h(Box, { flexDirection: "column", width: "100%" },
      displayedActiveMessage
        ? h(MessageList, { messages: [displayedActiveMessage] })
        : null,
      inspectedTool && !running
        ? h(ToolDetailInspector, {
            message: inspectedTool,
            onClose: handlers.closeInspector,
          })
        : null,
      completedMessages.length === 0 && !activeMessage && !pendingQuestion && plan.length === 0
        ? h(EmptyState)
        : null,
      h(PlanList, { plan }),
      h(SessionFooter, {
        running,
        plan,
        activeTool: activeMessage?.type === "tool" ? activeMessage : null,
        startedAt: runningStartedAt,
        waitingForAnswer: Boolean(pendingQuestion),
        promptProps: {
          onSubmit: pendingQuestion ? handlers.answerQuestion : handlers.submit,
          onCommand: handlers.command,
          onClear: handlers.clear,
          commands: COMMANDS,
          disabled: (running && !pendingQuestion) || Boolean(inspectedTool),
          activeModel: currentModel,
          questionOptions: pendingQuestion?.options || [],
          questionKind: pendingQuestion?.kind || "",
          permissionRequest: pendingQuestion?.permissionRequest || null,
          onSelectOption: handlers.answerQuestion,
          onCancelOption: handlers.cancelQuestion,
          secret: Boolean(pendingQuestion?.secret),
          fileItems: workspaceFiles,
        },
      }),
    ),
  ));
}
