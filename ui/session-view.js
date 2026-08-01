import { createElement as h } from "react";
import { Box, Static } from "ink";
import { ThemeProvider } from "./theme.js";
import { Banner } from "./components/banner.js";
import { MessageList } from "./components/message-list.js";
import { PlanList } from "./components/plan-list.js";
import { SessionFooter } from "./components/session-footer.js";
import { EmptyState } from "./components/empty-state.js";
import { SettingsMenu } from "./components/settings-menu.js";
import { SessionManager } from "./components/session-manager.js";
import { COMMANDS } from "./commands.js";
import { EMPTY_PLAN_STATE } from "../app/agent/plan.js";
import { displayModel } from "./session-helpers.js";

export function SessionView(context) {
  const { themeName, sessionKey, staticItems, currentModel, workspace, currentSessionRef, autoApproveRef, displayedActiveMessage, expandedTool, running, completedMessages, activeMessage, pendingQuestion, plan, planState, sessionManagerSessions, handleResumeSession, handleDeleteSession, handleClearSessions, setSessionManagerSessions, showSettings, settingsSection, handleCloseSettings, handleSettingChange, queuedCount, modeStatus, contextUsage, activeScopeRef, answerQuestion, handlePromptSubmit, handleCommand, clearDisplay, handleAbort, messageQueueRef, cancelQuestion, workspaceFiles, handleThemePreview, handleThemeExitSub } = context;
return h(ThemeProvider, { name: themeName }, h(Box, { flexDirection: "column", width: "100%" },
  h(Static, {
    key: `history-${sessionKey}`,
    items: staticItems,
  }, item => item.type === "banner"
    ? h(Banner, {
        key: item.id,
        model: currentModel,
        workspace: workspace.path,
        agent: currentSessionRef.current.agent,
        autoApprove: autoApproveRef.current,
      })
    : h(MessageList, { key: item.id, messages: [item] })),
  h(Box, { flexDirection: "column", width: "100%" },
    displayedActiveMessage
      ? h(MessageList, {
          key: displayedActiveMessage.id,
          messages: [displayedActiveMessage],
        })
      : null,
    expandedTool && !running
      ? h(MessageList, { messages: [expandedTool] })
      : null,
    completedMessages.length === 0 && !activeMessage && !pendingQuestion && plan.length === 0
      ? h(EmptyState)
      : null,
    h(PlanList, {
      key: planState.planId || "plan",
      plan: plan.length > 0 ? planState : EMPTY_PLAN_STATE,
    }),
    sessionManagerSessions !== null
      ? h(SessionManager, {
          key: "session-manager",
          workspacePath: workspace.path,
          sessions: sessionManagerSessions,
          currentSessionId: currentSessionRef.current.id,
          onResume: handleResumeSession,
          onDelete: handleDeleteSession,
          onClear: handleClearSessions,
          onClose: () => setSessionManagerSessions(null),
        })
      : null,
    showSettings
        ? h(SettingsMenu, {
            model: currentModel,
            initialSection: settingsSection === "reset" ? "reset" : settingsSection,
            onClose: handleCloseSettings,
            onSettingChange: handleSettingChange,
          })
        : h(SessionFooter, {
          key: "session-footer",
          running,
          waitingForAnswer: Boolean(pendingQuestion),
          queueCount: queuedCount,
          model: displayModel(currentModel),
          modeStatus,
          contextUsage,
          hasSpecificActivity: Boolean(
            displayedActiveMessage && displayedActiveMessage.type !== "streaming"
          ),
          activityScope: activeScopeRef.current,
          promptProps: {
            onSubmit: pendingQuestion ? answerQuestion : handlePromptSubmit,
            onCommand: handleCommand,
            onClear: clearDisplay,
            onAbort: handleAbort,
            commands: COMMANDS,
            inputActive: !messageQueueRef.current.exiting
              && sessionManagerSessions === null,
            canAbort: running && !pendingQuestion,
            activeModel: currentModel,
            questionOptions: pendingQuestion?.options || [],
            question: pendingQuestion?.question || "",
            questionContext: pendingQuestion?.context || "",
            questionKind: pendingQuestion?.kind || "",
            permissionRequest: pendingQuestion?.permissionRequest || null,
            onSelectOption: answerQuestion,
            onCancelOption: cancelQuestion,
            secret: Boolean(pendingQuestion?.secret),
            fileItems: workspaceFiles,
            onPreviewChange: handleThemePreview,
            onExitSub: handleThemeExitSub,
          },
        }),
  ),
));
}
