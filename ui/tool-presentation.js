import { normalizeVerticalWhitespace } from "./text-layout.js";
import { redactSecrets } from "../lib/secrets.js";
import stringWidth from "string-width";
export const TOOL_LABELS = {
  web: "Fetch",
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
  todowrite: "Plan updated",
};

export const TOOL_ACCENTS = {
  web: "toolRead",
  webfetch: "toolRead",
  websearch: "toolSearch",
  repo: "toolRepo",
  read: "toolRead",
  write: "toolWrite",
  edit: "toolWrite",
  apply_patch: "toolWrite",
  bash: "toolShell",
  analyze: "toolThink",
  task: "toolThink",
  glob: "toolSearch",
  grep: "toolSearch",
  todowrite: "toolWrite",
};

export const TOOL_STATE_COLORS = {
  running: "info",
  success: "success",
  warning: "warning",
  failed: "error",
};

export function formatDuration(ms) {
  if (ms === null || ms === undefined) return null;
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
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
  if (/^(?:Error|Syntax validation failed|Tool (?:execution )?(?:timed out|aborted))/i.test(text)) return "failed";
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

function sanitizeOutput(content) {
  return normalizeVerticalWhitespace(
    redactSecrets(String(content || ""))
      .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
      .replace(/\u001B(?:[@-_]|\[[0-?]*[ -/]*[@-~])/g, "")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .replace(/\b((?:authorization|cookie)\s*:\s*)[^\n]+/gi, "$1[REDACTED]")
      .replace(/\b((?:authorization|cookie|password|token|api[_-]?key)=)[^&\s]+/gi, "$1[REDACTED]")
      .replace(/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*)=([^\s]+)/g, "$1=[REDACTED]"),
  );
}

function truncateVisible(value, maximum) {
  const source = String(value || "").trim();
  if (stringWidth(source) <= maximum) return source;
  let output = "";
  for (const character of source) {
    if (stringWidth(output + character + "…") > maximum) break;
    output += character;
  }
  return `${output.trimEnd()}…`;
}

function concisePreview(lines, fallback, maximumLines = 2, maximumWidth = 160) {
  const unique = lines
    .map(line => String(line || "").replace(/\s+/g, " ").trim())
    .filter((line, index, all) => line && all.indexOf(line) === index);
  const selected = unique.length ? unique.slice(0, maximumLines) : [fallback];
  const result = [];
  let remaining = maximumWidth;
  for (const line of selected) {
    if (remaining < 2) break;
    const shortened = truncateVisible(line, remaining);
    if (!shortened) continue;
    result.push(shortened);
    remaining -= stringWidth(shortened);
  }
  return {
    lines: result,
    hiddenLines: Math.max(0, unique.length - result.length),
    hiddenChars: 0,
  };
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

function pathLabel(value) {
  const parts = String(value || "").split("/").filter(Boolean);
  return parts.at(-1) || String(value || "");
}

function shellSummary(command, state) {
  if (state === "running") return "Running shell command";
  if (state === "failed") return "Shell command failed";
  const source = String(command || "").trim();
  const remove = /^rm\s+(?:-[A-Za-z]+\s+)*([^\s;&|]+)/.exec(source);
  if (remove) return `Deleted ${pathLabel(remove[1])}`;
  const create = /^mkdir\s+(?:-[A-Za-z]+\s+)*([^\s;&|]+)/.exec(source);
  if (create) return `Created ${pathLabel(create[1])}`;
  const move = /^mv\s+([^\s;&|]+)\s+([^\s;&|]+)/.exec(source);
  if (move) return `Moved ${pathLabel(move[1])} to ${pathLabel(move[2])}`;
  return "Shell completed";
}

function shellCommand(command) {
  return sanitizeOutput(command)
    .replace(/\s+/g, " ")
    .trim();
}

function safeInline(value) {
  return sanitizeOutput(value).replace(/\s+/g, " ").trim();
}

function toolDetailTargets(tool, args, commandPreview) {
  if (tool === "bash") return commandPreview ? [{ label: "Command", value: commandPreview }] : [];
  if (tool === "web" || tool === "webfetch") return args.url ? [{ label: "URL", value: safeInline(args.url) }] : [];
  if (tool === "websearch") return args.query ? [{ label: "Query", value: safeInline(args.query) }] : [];
  if (tool === "grep" || tool === "glob") {
    return [
      args.pattern ? { label: "Pattern", value: safeInline(args.pattern) } : null,
      args.path ? { label: "Path", value: safeInline(args.path) } : null,
    ].filter(Boolean);
  }
  if (tool === "repo") {
    return [
      args.url ? { label: "URL", value: safeInline(args.url) } : null,
      args.path ? { label: "Path", value: safeInline(args.path) } : null,
    ].filter(Boolean);
  }
  const target = safeInline(toolTarget(tool, args));
  return target ? [{ label: "Path", value: target }] : [];
}

function countMatches(content, pattern) {
  return [...content.matchAll(pattern)].map(match => Number(match[1])).find(Number.isFinite);
}

function shellTestSummary(content) {
  const passed = countMatches(content, /(?:^|\s)(\d+)\s+(?:tests?\s+)?pass(?:ed)?\b/gim)
    ?? countMatches(content, /^\s*(?:#\s*)?pass(?:ed)?\s*:?\s*(\d+)\b/gim);
  const failed = countMatches(content, /(?:^|\s)(\d+)\s+(?:tests?\s+)?fail(?:ed)?\b/gim)
    ?? countMatches(content, /^\s*(?:#\s*)?fail(?:ed)?\s*:?\s*(\d+)\b/gim);
  if (passed === undefined && failed === undefined) return null;
  return `${passed || 0} tests passed, ${failed || 0} failed`;
}

function usefulShellLines(content, state) {
  const lines = content.split("\n")
    .map(line => line.trim())
    .filter(line =>
      line
      && !/^Exit:\s*-?\d+$/i.test(line)
      && !/^(?:npm (?:notice|warn)|[-=]{3,}|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])/.test(line)
    );
  if (state === "failed") return relevantErrorLines(lines).slice(0, 2);
  const scored = lines.map((line, index) => ({
    line,
    index,
    score: /tests?|passed|failed/i.test(line) ? 90
      : /built|build complete|compiled|typecheck|lint|success/i.test(line) ? 80
        : /created|written|modified|updated|generated/i.test(line) ? 70
          : 10,
  }));
  scored.sort((left, right) => right.score - left.score || right.index - left.index);
  if (scored.length > 2 && scored[0]?.score === 10) return [`Command produced ${scored.length} lines`];
  return scored.slice(0, 2).sort((left, right) => left.index - right.index).map(item => item.line);
}

function searchResultSummary(tool, content) {
  const found = /^Found\s+(\d+)/im.exec(content)?.[1];
  if (found === undefined) return null;
  if (tool === "glob") return `Found ${found} ${Number(found) === 1 ? "file" : "files"}`;
  if (tool === "grep") {
    const files = new Set(
      content.split("\n").slice(1)
        .map(line => /^(.+?):\d+(?::\d+)?:/.exec(line)?.[1])
        .filter(Boolean),
    );
    return `Found ${found} ${Number(found) === 1 ? "match" : "matches"}${files.size ? ` in ${files.size} ${files.size === 1 ? "file" : "files"}` : ""}`;
  }
  return `Found ${found} results`;
}

function planSummary(metadata, content) {
  const todos = Array.isArray(metadata?.todos) ? metadata.todos : [];
  if (!todos.length) return /^Cleared todos\./i.test(content) ? "No plan items remain" : null;
  const count = status => todos.filter(todo => todo?.status === status).length;
  return [
    `${count("completed")} completed`,
    `${count("in_progress")} active`,
    `${count("pending")} pending`,
  ].join(", ");
}

function resultSummary(tool, args, content, state, metadata) {
  const failed = state === "failed";
  const lines = content.split("\n").filter(Boolean);
  const fallback = failed
    ? `${TOOL_LABELS[tool] || tool} failed`
    : `${TOOL_LABELS[tool] || tool} completed with no output`;
  if (tool === "bash") {
    const test = metadata?.testExecution;
    if (test) {
      const seconds = Math.round(Number(test.timeoutMs || 0) / 1000);
      if (test.outcome === "timeout") {
        return concisePreview([`Test suite timed out after ${seconds}s`], "Test suite timed out");
      }
      if (test.outcome === "hanging") {
        return concisePreview([`Test process did not exit after completed output · ${seconds}s`], "Test process did not exit");
      }
      if (test.outcome === "exit-error") {
        return concisePreview(
          [`Test command exited with code ${test.exitCode}`, test.firstFailure ? `First failure: ${test.firstFailure}` : ""],
          "Test command failed",
        );
      }
      const duration = Number.isFinite(Number(test.durationMs))
        ? ` · ${(Number(test.durationMs) / 1000).toFixed(1)}s`
        : "";
      const summary = `${test.passed || 0} passed, ${test.failed || 0} failed, ${test.cancelled || 0} cancelled${duration}`;
      return concisePreview(
        [summary, test.firstFailure ? `First failure: ${test.firstFailure}` : ""],
        failed ? "Test command failed" : "Tests completed",
      );
    }
    if (/timed out|timeout/i.test(content)) {
      const text = /\b(?:test|pytest|jest|vitest)\b/i.test(args.command || "")
        ? "Timed out while running the test suite"
        : lines.find(line => /timed out|timeout/i.test(line)) || "Command timed out";
      return concisePreview([text], fallback);
    }
    if (!failed) {
      const tests = shellTestSummary(content);
      if (tests) return concisePreview([tests], fallback);
      if (/\b(?:run\s+)?build\b/i.test(args.command || "")) {
        return concisePreview(["Build completed successfully"], fallback);
      }
      if (/\b(?:lint|eslint)\b/i.test(args.command || "")) {
        return concisePreview(["Lint completed successfully"], fallback);
      }
      if (/\b(?:typecheck|tsc)\b/i.test(args.command || "")) {
        return concisePreview(["Typecheck completed successfully"], fallback);
      }
    }
    return concisePreview(usefulShellLines(content, state), failed ? "Shell command failed" : "Command completed with no output");
  }
  if (tool === "web" || tool === "webfetch") {
    const useful = lines.filter(line => !/^(?:URL|Content-Type|Bytes|Total\s+\d+\s+chars)\s*:?/i.test(line.trim()));
    const chars = /^Total\s+(\d+)\s+chars/im.exec(content)?.[1];
    return concisePreview(
      failed ? relevantErrorLines(lines) : useful,
      failed ? `${TOOL_LABELS[tool]} failed` : chars ? `Fetched ${chars} characters` : "Fetch completed with no content",
    );
  }
  if (tool === "read") {
    const count = /^Lines:\s*(\d+)/im.exec(content)?.[1];
    return concisePreview(count && !failed ? [`Read ${count} lines`] : failed ? relevantErrorLines(lines) : [], fallback);
  }
  if (["glob", "grep", "websearch"].includes(tool)) {
    const summary = searchResultSummary(tool, content);
    return concisePreview(summary && !failed ? [summary] : failed ? relevantErrorLines(lines) : lines.slice(0, 2), fallback);
  }
  if (tool === "write") {
    const bytes = /^Written\s+(\d+)\s+bytes/im.exec(content)?.[1];
    return concisePreview(bytes && !failed ? [`Wrote ${formatBytes(bytes)}`] : failed ? relevantErrorLines(lines) : lines, fallback);
  }
  if (tool === "edit") {
    const count = /Updated\s+(\d+)\s+matching sections?/i.exec(content)?.[1];
    return concisePreview(!failed ? [`Updated ${count || 1} matching ${count === "1" || !count ? "section" : "sections"}`] : relevantErrorLines(lines), fallback);
  }
  if (tool === "apply_patch") {
    const files = [...String(args.patchText || "").matchAll(/^\*\*\* (?:Add|Update|Delete) File:/gm)].length;
    return concisePreview(!failed ? [files ? `Applied patch to ${files} ${files === 1 ? "file" : "files"}` : "Patch applied successfully"] : relevantErrorLines(lines), fallback);
  }
  if (tool === "todowrite") {
    const summary = planSummary(metadata, content);
    return concisePreview(summary ? [summary] : failed ? relevantErrorLines(lines) : lines, fallback);
  }
  return concisePreview(failed ? relevantErrorLines(lines) : lines, fallback);
}

function toolSummary(tool, args, state) {
  if (tool === "bash") return shellSummary(args.command, state);
  if (tool === "todowrite") return "";
  if (state === "running") return `Running ${TOOL_LABELS[tool] || tool}`;
  if (state === "failed") return `${TOOL_LABELS[tool] || tool} failed`;
  if (tool === "write") return `Wrote ${pathLabel(args.path)}`;
  if (tool === "edit") return `Edited ${pathLabel(args.path)}`;
  if (tool === "read") return `Read ${pathLabel(args.path)}`;
  return toolTarget(tool, args) || `${TOOL_LABELS[tool] || tool} completed`;
}

export function presentTool({ tool, args = {}, content = "", done = false, duration = null, resultSize = 0, expanded = false, metadata: toolMetadata = {} }) {
  const normalized = sanitizeOutput(content);
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

  const fullCommand = tool === "bash" ? shellCommand(args.command) : "";
  const commandPreview = fullCommand.length > 96
    ? `${fullCommand.slice(0, 95).trimEnd()}…`
    : fullCommand;
  const target = sanitizeOutput(tool === "bash" ? commandPreview : toolTarget(tool, args))
    .replace(/\s+/g, " ")
    .trim();
  const targets = toolDetailTargets(tool, args, commandPreview);
  return {
    label: TOOL_LABELS[tool] || tool.charAt(0).toUpperCase() + tool.slice(1),
    accentRole: TOOL_ACCENTS[tool] || "toolRead",
    stateRole: TOOL_STATE_COLORS[state],
    state,
    statusLabel: state === "success" ? "completed" : state,
    duration: done ? formatDuration(duration) : null,
    target,
    targets,
    summary: toolSummary(tool, args, state),
    metadata: metadata.filter(Boolean),
    details: fullCommand ? [`Command  ${fullCommand}`] : [],
    fullCommand,
    commandPreview,
    commandTruncated: commandPreview !== fullCommand,
    marker: state === "success" ? "✓" : state === "failed" ? "×" : state === "warning" ? "!" : "•",
    monoMarker: state === "success" ? "[ok]" : state === "failed" ? "[error]" : state === "warning" ? "[warning]" : "[running]",
    preview,
    resultPreview: done ? resultSummary(tool, args, normalized, state, toolMetadata) : null,
    searchResults,
    expanded,
    expandable: done && Boolean(normalized || fullCommand),
    collapsible: Boolean(searchResults?.hidden || preview.hiddenLines || preview.hiddenChars),
  };
}
