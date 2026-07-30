export function formatContextUsage(usage = {}) {
  const budget = Math.max(1, Number(usage.budget) || 1);
  const used = Math.max(0, Number(usage.used) || 0);
  return `${Math.min(100, Math.floor((used / budget) * 100))}/100%`;
}

function tokens(value) {
  return Math.max(0, Number(value) || 0).toLocaleString("en-US");
}

export function formatUsageReport(usage = {}) {
  const lines = [
    "## Context Usage",
    "",
    `- Current context: ${tokens(usage.currentContextTokens)} tokens`,
    `- Projected request: ${tokens(usage.projectedRequestTokens)} tokens`,
  ];
  if (usage.contextLimitKnown) {
    lines.push(`- Context limit: ${tokens(usage.contextLimit)} tokens (${usage.contextLimitSource})`);
    lines.push(`- Usage: ${Math.min(100, Math.max(0, Number(usage.usagePercent) || 0)).toFixed(1)}%`);
  } else {
    lines.push("- Context limit: Unknown");
  }
  lines.push(`- Session input: ${tokens(usage.sessionInputTokens)} tokens`);
  lines.push(`- Session output: ${tokens(usage.sessionOutputTokens)} tokens`);
  return lines.join("\n");
}
