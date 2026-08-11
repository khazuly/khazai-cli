import { createElement as h, memo } from "react";
import { Text, Box } from "ink";
import { ToolCall } from "./tool-call.js";
import { CodePreview } from "./code-preview.js";
import { Markdown } from "./markdown.js";
import { normalizeVerticalWhitespace } from "../text-layout.js";
import { useTheme } from "../theme.js";
import { PrefixRow, StatusRail } from "./surface.js";

function hasCodePreview(message) {
  if (!message.done) return false;
  if (message.tool === "write") return /^Written \d+ bytes to /.test(message.content || "");
  if (message.tool === "edit") return /^Edited /.test(message.content || "");
  return false;
}

function FormattedAnswer({ content }) {
  return h(Markdown, { content });
}

function RoleMessage({ role, content }) {
  const theme = useTheme();
  return h(Box, {
    flexDirection: "column",
    marginBottom: 1,
  },
    h(Text, { bold: true, color: theme.primary }, role),
    h(Box, { flexDirection: "column", width: "100%" },
      h(FormattedAnswer, { content }),
    )
  );
}

function UserMessage({ content }) {
  const theme = useTheme();
  return h(Box, {
    flexDirection: "column",
    marginBottom: 1,
    borderStyle: "single",
    borderTop: false,
    borderBottom: false,
    borderRight: false,
    borderColor: theme.border,
  },
    h(Text, { bold: true, color: theme.metadata }, "You"),
    h(Text, { color: theme.inputText, wrap: "wrap" }, content),
  );
}

function ErrorDisplay({ content }) {
  const theme = useTheme();
  const lines = normalizeVerticalWhitespace(content || "Unknown error").split("\n");
  const suggestion = /syntax validation/i.test(content)
    ? "Review the reported location and rewrite the incomplete block."
    : /not found|does not exist/i.test(content)
      ? "Check the path or create the missing file first."
      : /timed? out/i.test(content)
        ? "Run the command manually or reduce the operation scope."
        : null;
  return h(StatusRail, {
    marginBottom: 1,
    tone: "error",
  },
    h(Text, { color: theme.error, bold: true }, "Error"),
    h(Box, { flexDirection: "column", marginTop: 1 },
      ...lines.map((line, index) => h(Text, { key: index, dimColor: index > 0, wrap: "wrap" }, line)),
      suggestion ? h(Text, { dimColor: true, wrap: "wrap" }, `Next  ${suggestion}`) : null,
    )
  );
}

function ProviderErrorDisplay({ content }) {
  const theme = useTheme();
  return h(Box, { marginBottom: 1 },
    h(Text, { color: theme.error, wrap: "wrap" }, content),
  );
}

function SummaryDisplay({ message }) {
  const theme = useTheme();
  const issues = Array.isArray(message.unresolvedIssues) ? message.unresolvedIssues : [];
  if (!issues.length) return null;
  return h(StatusRail, {
    marginBottom: 1,
    tone: "warning",
  },
    h(Text, { bold: true, color: theme.warning }, "Finished with issues"),
    ...issues.map((issue, index) => h(PrefixRow, {
      key: `issue-${index}`,
      prefix: "•",
      prefixWidth: 2,
      prefixColor: theme.warning,
    }, h(Text, { color: theme.warning, wrap: "wrap" }, issue))),
  );
}

function PermissionDisplay({ message }) {
  const theme = useTheme();
  const target = message.target && typeof message.target === "object" ? message.target : null;
  return h(StatusRail, {
    marginBottom: 1,
    tone: "warning",
  },
    h(Text, { bold: true, color: theme.warning }, "Action required"),
    h(Text, { color: theme.assistant, wrap: "wrap" }, message.action || message.reason),
    target?.value ? h(Text, { color: theme.toolTarget, wrap: "wrap" }, target.value) : null,
  );
}

function HistoryWindow({ count }) {
  const theme = useTheme();
  return h(Box, { marginBottom: 1 },
    h(Text, { color: theme.metadata, dimColor: true }, `${count} earlier messages remain available in this saved session.`),
  );
}

const MessageRow = memo(function MessageRow({ message: m }) {
  switch (m.type) {
    case "user":
      return h(UserMessage, { content: m.content });
    case "tool":
      return h(Box, { flexDirection: "column", marginBottom: 1 },
        h(ToolCall, {
          tool: m.tool, args: m.args, done: m.done, duration: m.duration,
          resultSize: m.resultSize, content: m.content, expanded: m.expanded,
          status: m.status, startedAt: m.startedAt, metadata: m.metadata,
          toolCallId: m.callId,
          scopeKey: `${m.runId || ""}:${m.turnId || ""}:${m.taskEpoch ?? ""}`,
        }),
        hasCodePreview(m)
          ? h(Box, { marginBottom: 1, width: "100%" },
              h(CodePreview, { tool: m.tool, args: m.args, expanded: Boolean(m.expanded) }))
          : null,
      );
    case "read-group":
      return h(Box, { flexDirection: "column", marginBottom: 1 },
        h(ToolCall, {
          readGroup: true, readBatch: m, expanded: m.expanded,
        }),
      );
    case "answer": return h(RoleMessage, { role: "KhazAI", content: m.content });
    case "think": return null;
    case "error": return h(ErrorDisplay, { content: m.content });
    case "provider-error": return h(ProviderErrorDisplay, { content: m.content });
    case "summary": return h(SummaryDisplay, { message: m });
    case "permission": return h(PermissionDisplay, { message: m });
    case "history-window": return h(HistoryWindow, { count: m.hiddenCount });
    default: return null;
  }
}, (previous, next) => previous.message === next.message);

export function MessageList({ messages }) {
  const items = messages.map(message => h(MessageRow, { key: message.id, message }));

  return h(Box, {
    flexDirection: "column",
    justifyContent: "flex-start",
    flexGrow: 0,
    flexShrink: 0,
  }, ...items);
}
