import { createElement as h } from "react";
import { useEffect, useState } from "react";
import { Text, Box } from "ink";
import { SPINNER_FRAMES } from "./status-bar.js";
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

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(Number(ms) || 0));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

function ThinkStatus({ message }) {
  const theme = useTheme();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (message.done) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [message.done]);
  const accumulated = message.accumulatedDurationMs
    ?? (message.done ? Math.max(0, (message.completedAt || 0) - (message.startedAt || 0)) : 0);
  const activeStartedAt = message.activeStartedAt ?? message.startedAt;
  const elapsed = formatElapsed(
    Number(accumulated || 0)
    + (!message.done && activeStartedAt ? Math.max(0, now - activeStartedAt) : 0)
  );
  const activity = message.text || "Analyzing the execution context";
  if (message.done) {
    return h(Box, { flexDirection: "column", marginBottom: 1 },
      h(Text, { color: message.failed ? theme.error : theme.success }, `${message.failed ? "[×]" : "[✓]"} ${activity} · ${elapsed}`),
    );
  }
  const frame = Math.floor(now / 120) % SPINNER_FRAMES.length;
  const next = [message.nextAction ? `Next: ${message.nextAction}` : "", message.progress]
    .filter(Boolean)
    .join(" · ");
  return h(Box, { flexDirection: "column", marginBottom: 1 },
    h(Box, { flexDirection: "row", width: "100%" },
      h(Text, { color: theme.metadata }, SPINNER_FRAMES[frame], " "),
      h(Box, { flexShrink: 1 },
        h(Text, { color: theme.metadata, wrap: "wrap" }, activity, " · ", elapsed),
      ),
    ),
    message.target
      ? h(Box, { marginLeft: 2, width: "100%" },
          h(Text, { color: theme.metadata, dimColor: true, wrap: "wrap" }, message.target),
        )
      : null,
    next
      ? h(Box, { marginLeft: 2, width: "100%" },
          h(Text, { color: theme.metadata, dimColor: true, wrap: "wrap" }, next),
        )
      : null,
    !message.target && !next && message.step
      ? h(Box, { marginLeft: 2 },
          h(Text, { color: theme.metadata, dimColor: true }, message.step),
        )
      : null,
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

export function MessageList({ messages }) {
  const items = messages.map(m => {
    switch (m.type) {
      case "user":
        return h(UserMessage, { key: m.id, content: m.content });
      case "tool":
        return h(Box, {
          key: m.id,
          flexDirection: "column",
          marginBottom: 1,
        },
          h(ToolCall, {
            tool: m.tool, args: m.args, done: m.done, duration: m.duration,
            resultSize: m.resultSize, content: m.content, expanded: m.expanded,
            status: m.status, startedAt: m.startedAt, metadata: m.metadata,
          }),
          hasCodePreview(m)
            ? h(Box, { marginBottom: 1, width: "100%" },
                h(CodePreview, { tool: m.tool, args: m.args, expanded: Boolean(m.expanded) })
              )
            : null,
        );
      case "read-group":
        return h(Box, { key: m.id, flexDirection: "column", marginBottom: 1 },
          h(ToolCall, {
            readGroup: true, count: m.count, currentFile: m.currentFile,
            done: m.done, duration: m.duration, failed: m.failed,
            status: m.status, totalLines: m.totalLines,
            failurePreview: m.failurePreview,
          }),
        );
      case "answer":
        return h(RoleMessage, { key: m.id, role: "KhazAI", content: m.content });
      case "think":
        return h(ThinkStatus, { key: m.id, message: m });
      case "error":
        return h(ErrorDisplay, { key: m.id, content: m.content });
      case "provider-error":
        return h(ProviderErrorDisplay, { key: m.id, content: m.content });
      case "summary":
        return h(SummaryDisplay, { key: m.id, message: m });
      case "permission":
        return h(PermissionDisplay, { key: m.id, message: m });
      default:
        return null;
    }
  }).filter(Boolean);

  return h(Box, {
    flexDirection: "column",
    justifyContent: "flex-start",
    flexGrow: 0,
    flexShrink: 0,
  }, ...items);
}
