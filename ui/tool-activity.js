import { presentTool } from "./tool-presentation.js";

const MAX_TOOL_CHOICES = 20;

export function recentToolMessages(messages, maximum = MAX_TOOL_CHOICES) {
  return messages
    .filter(message => (message.type === "tool" || message.type === "read-group") && message.done)
    .slice(-maximum)
    .reverse();
}

export function toolChoice(message) {
  if (message.type === "read-group") {
    const count = message.total || 0;
    const label = `Read ${count} ${count === 1 ? "file" : "files"}`;
    return message.failed ? `${label} · ${message.failed} failed` : label;
  }
  const presentation = presentTool({
    tool: message.tool,
    title: message.title,
    args: message.args,
    content: message.content,
    done: message.done,
    failed: message.failed,
    duration: message.duration,
    resultSize: message.resultSize,
    lifecycleMetadata: message.lifecycleMetadata,
  });
  const subject = presentation.target || presentation.headline || presentation.statusLabel;
  const duration = presentation.duration ? ` · ${presentation.duration}` : "";
  return `${presentation.label} · ${subject} · ${presentation.statusLabel}${duration}`;
}

export function findToolMessage(messages, id) {
  return messages.find(message =>
    (message.type === "tool" || message.type === "read-group")
    && (message.id === id || message.callId === id)
  ) || null;
}
