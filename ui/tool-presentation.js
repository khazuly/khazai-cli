import { normalizeVerticalWhitespace } from "./text-layout.js";
import { PASTEL } from "./palette.js";

export const TOOL_LABELS = {
  web: "Shell",
  webfetch: "Fetch",
  websearch: "Search",
  repo: "Repo",
  read: "Read",
  write: "Write",
  edit: "Edit",
  apply_patch: "Patch",
  bash: "Shell",
  analyze: "Think",
  task: "Think",
  glob: "Search",
  grep: "Search",
};

export const TOOL_ACCENTS = {
  web: PASTEL.blue,
  webfetch: PASTEL.blue,
  websearch: PASTEL.lavender,
  repo: PASTEL.sage,
  read: "#8297a6",
  write: PASTEL.violet,
  edit: PASTEL.mauve,
  apply_patch: PASTEL.mauve,
  bash: "#b09572",
  analyze: "#8b86a8",
  task: "#9385a5",
  glob: "#7f96aa",
  grep: "#9b819d",
};

export const TOOL_STATE_COLORS = {
  running: "#8c839f",
  success: PASTEL.slate,
  warning: PASTEL.amber,
  failed: PASTEL.rose,
};

export function formatDuration(ms) {
  if (ms === null || ms === undefined) return null;
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return null;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function classifyToolState(result, done = true) {
  if (!done) return "running";
  const text = String(result || "");
  if (/^(?:Warning|WARN(?:ING)?\b)/i.test(text)) return "warning";
  if (/^(?:Error|Syntax validation failed)/i.test(text)) return "failed";
  const exit = /^Exit:\s*(-?\d+)/im.exec(text);
  return exit && Number(exit[1]) !== 0 ? "failed" : "success";
}

export function toolTarget(tool, args = {}) {
  if (tool === "web" || tool === "webfetch") return args.url || "";
  if (tool === "apply_patch") {
    return [...String(args.patchText || "").matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)]
      .map(match => match[1])
      .join(" · ");
  }
  if (tool === "websearch") return args.query || "";
  if (tool === "repo") return [args.url, args.path].filter(Boolean).join(" · ");
  if (["read", "write", "edit", "analyze"].includes(tool)) return args.path || "";
  if (tool === "bash") return args.command || "";
  if (tool === "glob") return [args.pattern, args.path].filter(Boolean).join(" · ");
  if (tool === "grep") return [args.pattern, args.path].filter(Boolean).join(" · ");
  return args.path || args.url || args.query || args.command || "";
}

export function setLatestToolExpanded(messages, expanded, archivedCount = 0) {
  const index = messages.findLastIndex(message => message.type === "tool");
  if (index < archivedCount) return messages;
  return messages.map((message, messageIndex) =>
    messageIndex === index ? { ...message, expanded } : message
  );
}

function parseSearch(content) {
  const summary = /^Found\s+(\d+).*?showing\s+(\d+)/im.exec(content);
  const results = [];
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const heading = /^(\d+)\.\s+(.+)/.exec(lines[index].trim());
    if (!heading) continue;
    let description = "";
    for (let next = index + 1; next < lines.length && !/^\s*\d+\.\s+/.test(lines[next]); next++) {
      const value = lines[next].trim();
      if (!value || /^(?:URL|Source):/i.test(value)) continue;
      description = value;
      break;
    }
    results.push({ index: Number(heading[1]), title: heading[2], description });
  }
  return {
    found: summary ? Number(summary[1]) : results.length,
    showing: summary ? Number(summary[2]) : results.length,
    results,
  };
}

function relevantErrorLines(lines) {
  const important = lines.filter(line => /error|exception|failed|denied|not found|invalid|traceback|syntax/i.test(line));
  return [...important, ...lines].filter((line, index, all) => line && all.indexOf(line) === index);
}

function compactLines(content, state, expanded, maximum = 8) {
  let lines = normalizeVerticalWhitespace(content).split("\n").filter(Boolean);
  lines = lines.filter(line => !/^(?:URL|Content-Type|Bytes|Total\s+\d+\s+chars|Search results for|Found\s+\d+|File|Lines):?/i.test(line.trim()));
  if (state === "failed") lines = relevantErrorLines(lines);
  if (expanded) return { lines, hiddenLines: 0, hiddenChars: 0 };
  const selected = lines.slice(0, maximum);
  let hiddenChars = 0;
  const shortened = selected.map(line => {
    if (line.length <= 240) return line;
    hiddenChars += line.length - 240;
    return line.slice(0, 240);
  });
  return {
    lines: shortened,
    hiddenLines: Math.max(0, lines.length - maximum),
    hiddenChars,
  };
}

export function presentTool({ tool, args = {}, content = "", done = false, duration = null, resultSize = 0, expanded = false }) {
  const normalized = normalizeVerticalWhitespace(content || "");
  const state = classifyToolState(normalized, done);
  const metadata = [];
  let searchResults = null;
  let preview = { lines: [], hiddenLines: 0, hiddenChars: 0 };

  if (tool === "web" || tool === "webfetch") {
    const contentType = /^Content-Type:\s*([^|\n]+)/im.exec(normalized)?.[1]?.trim();
    const bytes = /^Bytes:\s*(\d+)/im.exec(normalized)?.[1];
    const chars = /^Total\s+(\d+)\s+chars/im.exec(normalized)?.[1];
    if (contentType) metadata.push(contentType);
    if (bytes) metadata.push(formatBytes(bytes));
    if (chars) metadata.push(`${chars} chars`);
    preview = compactLines(normalized, state, expanded, 8);
  } else if (tool === "websearch") {
    const parsed = parseSearch(normalized);
    if (parsed.found || parsed.showing) metadata.push(`${parsed.found} results`, `showing ${parsed.showing}`);
    const limit = expanded ? parsed.results.length : Math.min(3, parsed.results.length);
    if (parsed.results.length) {
      searchResults = {
        items: parsed.results.slice(0, limit),
        hidden: Math.max(0, parsed.showing - limit),
      };
    } else {
      preview = compactLines(normalized, state, expanded, 8);
    }
  } else if (tool === "bash") {
    const exit = /^Exit:\s*(-?\d+)/im.exec(normalized)?.[1];
    if (exit !== undefined) metadata.push(`exit ${exit}`);
    if (resultSize) metadata.push(formatBytes(resultSize));
    preview = compactLines(normalized.replace(/^Exit:[^\n]*\n?/i, ""), state, expanded, state === "failed" ? 5 : 3);
  } else {
    const writtenBytes = /^Written\s+(\d+)\s+bytes/im.exec(normalized)?.[1];
    const lineCount = /^Lines:\s*(\d+)/im.exec(normalized)?.[1];
    if (lineCount) metadata.push(`${lineCount} lines`);
    if (writtenBytes) metadata.push(formatBytes(writtenBytes));
    else if (resultSize && done) metadata.push(formatBytes(resultSize));
    preview = ["write", "edit"].includes(tool) && state === "success"
      ? { lines: [], hiddenLines: 0, hiddenChars: 0 }
      : compactLines(normalized, state, expanded, state === "failed" ? 5 : 3);
  }

  return {
    label: TOOL_LABELS[tool] || tool.charAt(0).toUpperCase() + tool.slice(1),
    accent: TOOL_ACCENTS[tool] || "#89929d",
    state,
    duration: done ? formatDuration(duration) : null,
    target: toolTarget(tool, args),
    metadata: metadata.filter(Boolean),
    preview,
    searchResults,
    collapsible: Boolean(searchResults?.hidden || preview.hiddenLines || preview.hiddenChars),
  };
}
