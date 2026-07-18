import { loadConfig } from "../config/index.js";
import { getLspManager, resolveLspDefinitions } from "../app/lsp.js";

export function createLspTool(workspace, config = loadConfig(workspace)) {
  const definitions = resolveLspDefinitions(workspace, config);
  if (definitions.length === 0) return null;
  const manager = getLspManager(workspace, config);
  return {
    name: "lsp",
    description: "Query configured language servers for diagnostics and semantic code intelligence.",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: [
            "diagnostics",
            "goToDefinition",
            "findReferences",
            "hover",
            "documentSymbol",
            "workspaceSymbol",
          ],
        },
        path: { type: "string", description: "Workspace-relative source file path." },
        line: { type: "integer", minimum: 1, description: "One-based line number." },
        character: { type: "integer", minimum: 1, description: "One-based character number." },
        query: { type: "string", description: "Symbol query for workspaceSymbol." },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    async execute(args) {
      if (args.operation !== "workspaceSymbol" && !args.path) {
        return "LSP error: path is required for this operation.";
      }
      return manager.query(args);
    },
    async afterFileChange(path) {
      return manager.diagnostics(path, { silentUnavailable: true });
    },
    status() {
      return manager.status();
    },
    shutdown() {
      return manager.shutdown();
    },
  };
}
