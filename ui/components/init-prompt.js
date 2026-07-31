import { createElement as h, useState, useRef, useCallback } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { useTheme } from "../theme.js";

const MODES = {
  create: {
    title: "Generate AGENTS.md?",
    options: [
      { label: "Generate AGENTS.md (Recommended)", value: "generate" },
      { label: "Preview full content", value: "preview" },
      { label: "Cancel", value: "cancel" },
    ],
  },
  update: {
    title: "AGENTS.md already exists",
    options: [
      { label: "Update while preserving custom rules (Recommended)", value: "update" },
      { label: "Replace the entire file", value: "replace" },
      { label: "Preview proposed changes", value: "preview" },
      { label: "Cancel", value: "cancel" },
    ],
  },
  replaceConfirm: {
    title: "Replace entire AGENTS.md?",
    options: [
      { label: "Yes, replace everything", value: "replace" },
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

function scrollPreview(text, offset, height) {
  const lines = text.split("\n");
  if (lines.length <= height) return { visibleLines: lines, totalLines: lines.length, atTop: true, atBottom: true };
  const clampedOffset = Math.max(0, Math.min(offset, lines.length - height));
  const visible = lines.slice(clampedOffset, clampedOffset + height);
  return {
    visibleLines: visible,
    totalLines: lines.length,
    offset: clampedOffset,
    atTop: clampedOffset === 0,
    atBottom: clampedOffset >= lines.length - height,
  };
}

export function InitPrompt({
  mode,
  workspaceRoot,
  sectionCount,
  inspectedCount,
  previewContent,
  proposedContent,
  onGenerate,
  onUpdate,
  onReplace,
  onPreview,
  onCancel,
}) {
  const theme = useTheme();
  const { stdout } = useStdout();
  const columns = stdout?.columns || 80;
  const contentWidth = Math.max(10, columns - 6);

  const config = MODES[mode] || MODES.create;
  const [selected, setSelected] = useState(0);
  const [showFullPreview, setShowFullPreview] = useState(false);
  const [previewOffset, setPreviewOffset] = useState(0);
  const [replaceStep, setReplaceStep] = useState(false);
  const confirmed = useRef(false);

  const content = proposedContent || previewContent || "";
  const previewHeight = Math.max(3, Math.min(15, (stdout?.rows || 24) - 10));
  const previewInfo = scrollPreview(content, previewOffset, previewHeight);

  const handleConfirm = useCallback(() => {
    if (confirmed.current) return;
    confirmed.current = true;
    const option = config.options[selected];
    if (!option) return;
    if (mode === "replaceConfirm") {
      if (option.value === "replace") onReplace?.();
      else onCancel?.();
      return;
    }
    if (option.value === "generate") onGenerate?.();
    else if (option.value === "update") onUpdate?.();
    else if (option.value === "replace") {
      if (replaceStep) {
        onReplace?.();
      } else {
        setReplaceStep(true);
        confirmed.current = false;
      }
    } else if (option.value === "preview") {
      setShowFullPreview(true);
      confirmed.current = false;
    } else {
      onCancel?.();
    }
  }, [selected, config, mode, replaceStep, onGenerate, onUpdate, onReplace, onPreview, onCancel]);

  const handleCancel = useCallback(() => {
    if (confirmed.current) return;
    confirmed.current = true;
    onCancel?.();
  }, [onCancel]);

  useInput((input, key) => {
    if (confirmed.current) return;
    if (showFullPreview) {
      if (key.escape || input === "q") {
        setShowFullPreview(false);
        confirmed.current = false;
        return;
      }
      if (key.upArrow || key.pageUp) {
        setPreviewOffset(prev => Math.max(0, prev - (key.pageUp ? previewHeight : 1)));
        return;
      }
      if (key.downArrow || key.pageDown) {
        setPreviewOffset(prev => prev + (key.pageDown ? previewHeight : 1));
        return;
      }
      if (key.home) {
        setPreviewOffset(0);
        return;
      }
      if (key.end) {
        setPreviewOffset(content.split("\n").length);
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

  if (showFullPreview) {
    return h(Box, {
      flexDirection: "column",
      borderStyle: "single",
      borderColor: theme.border,
      paddingX: 2,
      paddingY: 1,
      marginTop: 1,
      width: columns,
    },
      h(Text, { bold: true, color: theme.primary }, "AGENTS.md Preview"),
      h(Box, { flexDirection: "column", marginTop: 1, marginBottom: 1 },
        ...previewInfo.visibleLines.map((line, i) =>
          h(Text, {
            key: `${previewInfo.offset + i}`,
            color: theme.text,
            wrap: "wrap",
          }, line)
        ),
      ),
      h(Text, { color: theme.muted, dimColor: true, wrap: "wrap" },
        `L ${previewInfo.offset + 1}-${Math.min(previewInfo.offset + previewHeight, previewInfo.totalLines)} / ${previewInfo.totalLines} · ↑↓ scroll · Esc close`,
      ),
    );
  }

  const pathLines = wrapText(workspaceRoot, contentWidth);

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

    h(Text, " "),

    h(Box, { flexDirection: "column" },
      h(Text, { bold: true, color: theme.metadata }, "Path"),
      ...pathLines.map((line, i) => h(Text, {
        key: `path-${i}`,
        color: theme.toolTarget,
        wrap: "wrap",
      }, line)),
    ),

    h(Text, " "),

    h(Box, { flexDirection: "column" },
      h(Box, { marginBottom: 1 },
        h(Box, { width: 12, flexShrink: 0 }, h(Text, { color: theme.muted }, "Sections")),
        h(Text, { color: theme.text }, String(sectionCount)),
      ),
      h(Box, { marginBottom: 1 },
        h(Box, { width: 12, flexShrink: 0 }, h(Text, { color: theme.muted }, "Source")),
        h(Text, { color: theme.text }, `${inspectedCount} inspected files`),
      ),
    ),

    h(Text, " "),

    h(Box, { flexDirection: "column" },
      ...config.options.map((opt, index) =>
        h(Text, {
          key: opt.label,
          color: index === selected ? theme.primary : theme.muted,
          bold: index === selected,
          dimColor: index !== selected,
          wrap: "wrap",
        }, index === selected ? "› " : "  ", opt.label),
      ),
    ),

    h(Text, " "),

    h(Text, { color: theme.muted, dimColor: true, wrap: "wrap" },
      "↑↓ Select · Enter Confirm · Esc Cancel",
    ),
  );
}
