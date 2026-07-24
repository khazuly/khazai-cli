import { createElement as h } from "react";
import { useEffect, useState } from "react";
import { Text, Box, useStdout } from "ink";
import { SPINNER_FRAMES } from "./status-bar.js";
import { ToolCall } from "./tool-call.js";
import { CodePreview } from "./code-preview.js";
import { Markdown } from "./markdown.js";
import { normalizeVerticalWhitespace } from "../text-layout.js";
import { useTheme } from "../theme.js";
import { StatusRail } from "./surface.js";
import { streamViewportText } from "../stream-viewport.js";

function hasCodePreview(message) {
  if (!message.done) return false;
  if (message.tool === "write") return /^Written \d+ bytes to /.test(message.content || "");
  if (message.tool === "edit") return /^Edited /.test(message.content || "");
  return false;
}

function FormattedAnswer({ content }) {
  return h(Markdown, { content: normalizeVerticalWhitespace(content || "") });
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
  const elapsed = formatElapsed((message.completedAt || now) - message.startedAt);
  const activity = message.text || "Analyzing the execution context";
  if (message.done) {
    return h(Box, { flexDirection: "column", marginBottom: 1 },
      h(Text, { color: message.failed ? theme.error : theme.success }, `${message.failed ? "[×]" : "[✓]"} ${activity} · ${elapsed}`),
    );
  }
  const frame = Math.floor(now / 120) % SPINNER_FRAMES.length;
  return h(Box, { flexDirection: "column", marginBottom: 1 },
    h(Text, { color: theme.metadata }, SPINNER_FRAMES[frame], " ", activity, " · ", elapsed),
    message.step ? h(Text, { color: theme.metadata, dimColor: true }, "  ", message.step) : null,
  );
}

function StreamingMessage({ content, width }) {
  const theme = useTheme();
  const { stdout } = useStdout();
  const lines = streamViewportText(content, width || stdout?.columns || 80, 5).split("\n");
  return h(Box, {
    flexDirection: "column",
    width: width || "100%",
  },
    h(Text, { bold: true, color: theme.primary }, "KhazAI"),
    ...lines.map((line, index) => h(Text, {
      key: index,
      color: theme.assistant,
      wrap: "truncate-end",
      width: width || "100%",
    }, line || " ")),
    h(Text, { color: theme.metadata, dimColor: true }, "▋"),
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

function SummaryDisplay({ message }) {
  const theme = useTheme();
  const duration = message.duration < 1000 ? `${message.duration} ms` : `${(message.duration / 1000).toFixed(1)} s`;
  const headline = message.status === "attention" ? "Finished with issues" : "Finished";
  const details = [`${message.tools} ${message.tools === 1 ? "tool" : "tools"}`, duration];
  const files = Array.isArray(message.files) ? message.files : [];
  const validations = Array.isArray(message.validations) ? message.validations.slice(0, 3) : [];
  return h(StatusRail, {
    marginBottom: 1,
    tone: message.status === "attention" ? "warning" : "success",
  },
    h(Box, null,
      h(Text, { bold: true, color: message.status === "attention" ? theme.warning : theme.success }, headline),
      h(Text, { color: theme.metadata }, "  ", details.join(" · ")),
    ),
    files.length
      ? h(Text, { color: theme.toolTarget, wrap: "wrap" }, `Files  ${files.slice(0, 3).join(" · ")}${files.length > 3 ? ` · +${files.length - 3}` : ""}`)
      : null,
    ...validations.map((validation, index) => h(Text, {
      key: `validation-${index}`,
      color: validation.exitCode === 0 ? theme.success : theme.error,
      wrap: "wrap",
    }, `Check  ${String(validation.command).replace(/\s+/g, " ").slice(0, 120)}${String(validation.command).replace(/\s+/g, " ").length > 120 ? "…" : ""} · exit ${validation.exitCode}${validation.duration ? ` · ${validation.duration}` : ""}`)),
    message.validationMissing
      ? h(Text, { color: theme.warning }, "Check  not run")
      : null,
  );
}

function PermissionDisplay({ message }) {
  const theme = useTheme();
  return h(StatusRail, {
    marginBottom: 1,
    tone: "warning",
  },
    h(Text, { bold: true, color: theme.warning }, "Action required"),
    h(Text, { color: theme.assistant, wrap: "wrap" }, message.reason),
    message.tool ? h(Text, { color: theme.toolTarget, wrap: "wrap" }, `${message.tool}  ${message.target || ""}`.trim()) : null,
  );
}

export function MessageList({ messages, streamingWidth = null }) {
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
          }),
        );
      case "answer":
        return h(RoleMessage, { key: m.id, role: "KhazAI", content: m.content });
      case "streaming":
        return h(StreamingMessage, { key: m.id, content: m.content, width: streamingWidth });
      case "think":
        return h(ThinkStatus, { key: m.id, message: m });
      case "error":
        return h(ErrorDisplay, { key: m.id, content: m.content });
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
