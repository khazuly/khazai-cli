import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { existsSync, writeFileSync } from "node:fs";

const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
);
const documents = new Map();

function diagnostics(uri) {
  const text = documents.get(uri)?.text || "";
  return text.includes("BROKEN")
    ? [{
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 6 },
        },
        severity: 1,
        source: "fake-lsp",
        message: "Fake semantic error",
      }]
    : [];
}

connection.onRequest("initialize", () => ({
  capabilities: {
    textDocumentSync: 1,
    diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false },
    definitionProvider: true,
    referencesProvider: true,
    hoverProvider: true,
    documentSymbolProvider: true,
    workspaceSymbolProvider: true,
  },
}));
connection.onNotification("textDocument/didOpen", params => {
  documents.set(params.textDocument.uri, {
    version: params.textDocument.version,
    text: params.textDocument.text,
  });
  connection.sendNotification("textDocument/publishDiagnostics", {
    uri: params.textDocument.uri,
    diagnostics: diagnostics(params.textDocument.uri),
  });
});
connection.onNotification("textDocument/didChange", params => {
  documents.set(params.textDocument.uri, {
    version: params.textDocument.version,
    text: params.contentChanges.at(-1)?.text || "",
  });
  connection.sendNotification("textDocument/publishDiagnostics", {
    uri: params.textDocument.uri,
    diagnostics: diagnostics(params.textDocument.uri),
  });
});
connection.onRequest("textDocument/diagnostic", params => ({
  kind: "full",
  items: diagnostics(params.textDocument.uri),
}));
connection.onRequest("textDocument/definition", params => ({
  uri: params.textDocument.uri,
  range: {
    start: { line: 1, character: 2 },
    end: { line: 1, character: 8 },
  },
}));
connection.onRequest("textDocument/references", params => [{
  uri: params.textDocument.uri,
  range: {
    start: { line: 2, character: 3 },
    end: { line: 2, character: 9 },
  },
}]);
connection.onRequest("textDocument/hover", () => {
  if (process.env.KHAZAI_FAKE_LSP_HANG_HOVER) return new Promise(() => {});
  if (process.env.KHAZAI_FAKE_LSP_CRASH_MARKER) {
    const marker = process.env.KHAZAI_FAKE_LSP_CRASH_MARKER;
    if (!existsSync(marker)) {
      writeFileSync(marker, "crashed\n");
      setImmediate(() => process.exit(2));
      return new Promise(() => {});
    }
    return { contents: { kind: "markdown", value: "**RecoveredType**" } };
  }
  return { contents: { kind: "markdown", value: "**FakeType**" } };
});
connection.onRequest("textDocument/documentSymbol", params => [{
  name: "FakeDocumentSymbol",
  kind: 12,
  range: {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 10 },
  },
  selectionRange: {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 10 },
  },
}]);
connection.onRequest("workspace/symbol", () => []);
connection.onRequest("shutdown", () => null);
connection.onNotification("exit", () => process.exit(0));
connection.listen();
