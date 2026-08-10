const READ_ONLY_NATIVE_TOOLS = new Set([
  "read", "glob", "grep", "websearch", "webfetch", "question", "think", "skill", "todowrite",
]);

export function toolIsReadOnly(call, definition = null) {
  const name = String(call?.name || "");
  if (READ_ONLY_NATIVE_TOOLS.has(name)) return true;
  if (name.startsWith("mcp__")) return definition?.mcp?.readOnly === true;
  return false;
}
