function escapePattern(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function requiredMcpServer(registry, request, instructions) {
  const servers = [...new Set(registry.list().map(tool => tool.mcp?.server).filter(Boolean))];
  if (servers.length === 0) return null;
  const userText = String(request || "");
  const instructionText = String(instructions || "");
  for (const server of servers) {
    const name = escapePattern(server);
    const named = new RegExp(`(?:\\bmcp\\b.{0,40}\\b${name}\\b|\\b${name}\\b.{0,40}\\bmcp\\b)`, "i");
    if (named.test(userText)) return server;
    const mandated = new RegExp(`\\b(?:must|required|require|use)\\b.{0,80}(?:\\bmcp\\b.{0,40}\\b${name}\\b|\\b${name}\\b.{0,40}\\bmcp\\b)`, "i");
    if (mandated.test(instructionText)) return server;
  }
  if (servers.length === 1 && /\buse\b.{0,30}\bmcp\b/i.test(userText)) return servers[0];
  return null;
}

export function usedMcpServer(registry, evidence, server) {
  const names = new Set(registry.list()
    .filter(tool => tool.mcp?.server === server)
    .map(tool => tool.name));
  return evidence.some(entry => !entry.failed && names.has(entry.tool));
}
