import { createElement as h, useState, useRef, useCallback, useMemo } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { useTheme } from "../theme.js";
import { diffLines } from "../../lib/init-task.js";

const MODES = {
  create: {
    title: "AGENTS.md Preview",
    options: [
      { label: "Write AGENTS.md (Recommended)", value: "write" },
      { label: "Review full content", value: "preview" },
      { label: "Regenerate", value: "regenerate" },
      { label: "Add custom instruction", value: "custom" },
      { label: "Generate basic template without AI", value: "basic" },
      { label: "Cancel", value: "cancel" },
    ],
  },
  update: {
    title: "AGENTS.md already exists",
    options: [
      { label: "Update while preserving custom rules (Recommended)", value: "update" },
      { label: "Replace the file", value: "replace" },
      { label: "Review proposed diff", value: "diff" },
      { label: "Regenerate", value: "regenerate" },
      { label: "Add custom instruction", value: "custom" },
      { label: "Cancel", value: "cancel" },
    ],
  },
  replaceConfirm: {
    title: "Replace entire AGENTS.md?",
    options: [
      { label: "Cancel", value: "cancel" },
      { label: "Yes, replace everything", value: "replace" },
    ],
  },
  failed: {
    title: "AGENTS.md generation failed",
    options: [
      { label: "Retry", value: "retry" },
      { label: "Change model", value: "model" },
      { label: "Cancel", value: "cancel" },
    ],
  },
};

function wrapText(value, width) {
  if (!value) return [""];
  const lines = [];
  let current = "";
  for (const token of String(value).split(/(?<=[/\\_\-\s])/)) {
    if (current && current.length + token.length > width) {
      lines.push(current);
      current = "";
    }
    let remaining = token;
    while (remaining.length > width) {
      lines.push(remaining.slice(0, width));
      remaining = remaining.slice(width);
    }
    current += remaining;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function scrollPreview(lines, offset, height) {
  if (lines.length <= height) {
    return { visibleLines: lines, totalLines: lines.length, offset: 0, atTop: true, atBottom: true };
  }
  const clampedOffset = Math.max(0, Math.min(offset, lines.length - height));
  return {
    visibleLines: lines.slice(clampedOffset, clampedOffset + height),
    totalLines: lines.length,
    offset: clampedOffset,
    atTop: clampedOffset === 0,
    atBottom: clampedOffset >= lines.length - height,
  };
}

function ScrollableView({ title, lines, columns, theme, hint }) {
  const [offset, setOffset] = useState(0);
  const height = Math.max(3, Math.min(15, (columns?.rows || 24) - 12));
  const view = scrollPreview(lines, offset, height);
  return h(Box, {
    flexDirection: "column",
    borderStyle: "single",
    borderColor: theme.border,
    paddingX: 2,
    paddingY: 1,
    marginTop: 1,
    width: columns?.columns || 80,
  },
    h(Text, { bold: true, color: theme.primary }, title),
    h(Box, { flexDirection: "column", marginTop: 1, marginBottom: 1 },
      ...view.visibleLines.map((line, index) =>
        h(Text, {
          key: `${view.offset + index}-${line.type || "line"}`,
          color: line.type === "add"
            ? theme.success
            : line.type === "remove"
              ? theme.error
              : theme.text,
          wrap: "wrap",
        }, `${line.type === "add" ? "+ " : line.type === "remove" ? "- " : "  "}${line.text}`),
      ),
    ),
    h(Text, { color: theme.muted, dimColor: true, wrap: "wrap" },
      `L ${view.offset + 1}-${Math.min(view.offset + height, view.totalLines)} / ${view.totalLines} · ↑↓ scroll · Esc close`,
    ),
  );
}

export function InitPrompt({
  mode,
  workspaceRoot,
  inspectedCount,
  sectionCount,
  wordCount,
  previewContent,
  proposedContent,
  existingContent,
  warnings = [],
  error = "",
  onWrite,
  onUpdate,
  onReplace,
  onRegenerate,
  onCustomInstruction,
  onBasic,
  onChangeModel,
  onCancel,
}) {
  const theme = useTheme();
  const { stdout } = useStdout();
  const columns = stdout?.columns || 80;
  const contentWidth = Math.max(10, columns - 6);

  const config = MODES[mode] || MODES.create;
  const [selected, setSelected] = useState(0);
  const [view, setView] = useState(null); // "content" | "diff"
  const confirmed = useRef(false);

  const content = proposedContent || previewContent || "";
  const diffRows = useMemo(
    () => mode === "update" ? diffLines(existingContent || "", content) : [],
    [mode, existingContent, content],
  );

  const runOption = useCallback((value, allowRepeat = false) => {
    if (confirmed.current && !allowRepeat) return;
    if (!allowRepeat) confirmed.current = true;
    if (value === "write") onWrite?.();
    else if (value === "update") onUpdate?.();
    else if (value === "replace") onReplace?.();
    else if (value === "regenerate") onRegenerate?.();
    else if (value === "custom") onCustomInstruction?.();
    else if (value === "basic") onBasic?.();
    else if (value === "model") onChangeModel?.();
    else onCancel?.();
  }, [onWrite, onUpdate, onReplace, onRegenerate, onCustomInstruction, onBasic, onChangeModel, onCancel]);

  const handleConfirm = useCallback(() => {
    const option = config.options[selected];
    if (!option) return;
    if (option.value === "preview") {
      setView("content");
      confirmed.current = false;
      return;
    }
    if (option.value === "diff") {
      setView("diff");
      confirmed.current = false;
      return;
    }
    runOption(option.value);
  }, [config, selected, runOption]);

  const handleCancel = useCallback(() => {
    if (confirmed.current) return;
    confirmed.current = true;
    onCancel?.();
  }, [onCancel]);

  useInput((input, key) => {
    if (confirmed.current) return;
    if (view) {
      if (key.escape || input === "q") {
        setView(null);
        confirmed.current = false;
        return;
      }
      return;
    }
    if (key.upArrow) {
      setSelected(prev => (prev === 0 ? config.options.length - 1 : prev - 1));
      return;
    }
    if (key.downArrow) {
      setSelected(prev => (prev + 1) % config.options.length);
      return;
    }
    if (key.return) {
      handleConfirm();
      return;
    }
    if (key.escape) {
      handleCancel();
      return;
    }
  });

  if (view === "content") {
    return h(ScrollableView, {
      title: "AGENTS.md — full content",
      lines: content.split("\n").map(text => ({ type: null, text })),
      columns: stdout,
      theme,
    });
  }

  if (view === "diff") {
    return h(ScrollableView, {
      title: "AGENTS.md — proposed diff",
      lines: diffRows,
      columns: stdout,
      theme,
    });
  }

  const pathLines = wrapText(workspaceRoot, contentWidth);
  const lengthText = wordCount > 0 ? `${wordCount} words` : `${sectionCount} sections`;

  return h(Box, {
    flexDirection: "column",
    borderStyle: "single",
    borderColor: theme.border,
    paddingX: 2,
    paddingY: 1,
    marginTop: 1,
    width: columns,
  },
    h(Text, { bold: true, color: theme.primary }, config.title),

    mode === "failed"
      ? h(Box, { flexDirection: "column", marginTop: 1 },
          h(Text, { color: theme.error, bold: true }, "[×] AGENTS.md generation failed."),
          error ? h(Text, { color: theme.muted, wrap: "wrap", marginTop: 1 }, error) : null,
        )
      : h(Box, { flexDirection: "column" },
          h(Text, " "),
          h(Box, { flexDirection: "column" },
            h(Text, { bold: true, color: theme.metadata }, "Path"),
            ...pathLines.map((line, index) => h(Text, {
              key: `path-${index}`,
              color: theme.toolTarget,
              wrap: "wrap",
            }, line)),
          ),
          h(Text, " "),
          h(Box, { flexDirection: "column" },
            h(Box, { marginBottom: 1 },
              h(Box, { width: 12, flexShrink: 0 }, h(Text, { color: theme.muted }, "Inspected")),
              h(Text, { color: theme.text }, `${inspectedCount} files`),
            ),
            h(Box, { marginBottom: 1 },
              h(Box, { width: 12, flexShrink: 0 }, h(Text, { color: theme.muted }, "Length")),
              h(Text, { color: theme.text }, lengthText),
            ),
            h(Box, { marginBottom: 1 },
              h(Box, { width: 12, flexShrink: 0 }, h(Text, { color: theme.muted }, "Sections")),
              h(Text, { color: theme.text }, String(sectionCount)),
            ),
          ),
          warnings.length > 0
            ? h(Box, { flexDirection: "column", marginTop: 1 },
                ...warnings.map(warning =>
                  h(Text, { key: warning, color: theme.warning, wrap: "wrap" }, `! ${warning}`)),
              )
            : null,
        ),

    h(Text, " "),

    h(Box, { flexDirection: "column" },
      ...config.options.map((option, index) =>
        h(Text, {
          key: option.label,
          color: index === selected ? theme.primary : theme.muted,
          bold: index === selected,
          dimColor: index !== selected,
          wrap: "wrap",
        }, index === selected ? "› " : "  ", option.label),
      ),
    ),

    h(Text, " "),

    h(Text, { color: theme.muted, dimColor: true, wrap: "wrap" },
      "↑↓ Select · Enter Confirm · Esc Cancel",
    ),
  );
}
