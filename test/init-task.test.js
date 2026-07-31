import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../app/agent.js";
import { Registry } from "../app/registry.js";
import { builtinTools } from "../app/builtin-tools.js";
import {
  INIT_TOOLS,
  buildInitTaskPrompt,
  collectInitEvidence,
  diffLines,
  parseInitResult,
  prepareInitPreview,
  validateEvidenceReferences,
  validateInitResult,
} from "../lib/init-task.js";
import { writeAtomicFile } from "../lib/init-generator.js";
import {
  appendResponseDelta,
  commitResponseBuffer,
  createResponseBuffer,
  discardResponseBuffer,
} from "../ui/session-runtime.js";
import {
  initFailedState,
  initPreviewIsCurrent,
  initPreviewState,
  initValidatingState,
  mergeExistingContent,
} from "../ui/session.js";

function fixtureWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "khazai-init-"));
  mkdirSync(join(root, "lib"));
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "fixture-app",
    description: "A fixture application",
    type: "module",
    scripts: {
      test: "node --test test/*.test.js",
      lint: "eslint .",
      build: "vite build",
    },
  }));
  writeFileSync(join(root, "README.md"), "# Fixture App\n\nReadme content.\n");
  writeFileSync(join(root, "lib", "main.js"), "export function main() { return 42; }\n");
  writeFileSync(join(root, "test", "main.test.js"), "import test from 'node:test';\n");
  return root;
}

test("parseInitResult extracts the structured JSON envelope", () => {
  const source = `Some prose before.\n\n\`\`\`json\n{
  "workspaceRoot": "/tmp/demo",
  "generatedMarkdown": "# Demo\\n\\nContent.",
  "warnings": ["note"],
  "evidenceSummary": "inspected 3 files"
}\n\`\`\``;
  const parsed = parseInitResult(source);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result.generatedMarkdown, "# Demo\n\nContent.");
  assert.equal(parsed.result.evidenceSummary, "inspected 3 files");
});

test("parseInitResult falls back to raw Markdown without the envelope", () => {
  const parsed = parseInitResult("# Project Overview\n\nDirect markdown.");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result.generatedMarkdown, "# Project Overview\n\nDirect markdown.");
  assert.ok(parsed.fallback);
});

test("parseInitResult rejects empty or non-structured responses", () => {
  assert.equal(parseInitResult("").ok, false);
  assert.equal(parseInitResult("just some prose").ok, false);
  assert.equal(parseInitResult("[]").ok, false);
});

test("validateInitResult requires non-empty Markdown starting with a heading", () => {
  assert.equal(validateInitResult({ generatedMarkdown: "" }).valid, false);
  assert.equal(validateInitResult({ generatedMarkdown: "not a heading" }).valid, false);
  const valid = validateInitResult({
    generatedMarkdown: "# Project Overview\n\nThis project does things. " + "word ".repeat(20),
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.sectionCount, 1);
  assert.ok(valid.wordCount > 0);
});

test("validateInitResult rejects content that may contain secrets", () => {
  const result = validateInitResult({
    generatedMarkdown: "# Project\n\nUse token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef to authenticate.",
  });
  assert.equal(result.valid, false);
});

test("validateEvidenceReferences flags unobserved scripts and paths", () => {
  const evidence = {
    packageScripts: { test: "node --test" },
    inspectedFiles: ["lib/main.js"],
    directories: ["lib", "test"],
    configFiles: ["tsconfig.json"],
  };
  const warnings = validateEvidenceReferences(
    "# Commands\n\nRun `npm run test` and `npm run build`.\n\nSources live in `lib/main.js` and `src/index.ts`.",
    evidence,
  );
  assert.ok(warnings.some(warning => warning.includes("npm run build")));
  assert.ok(warnings.some(warning => warning.includes("src/index.ts")));
  assert.ok(!warnings.some(warning => warning.includes("npm run test")));
  assert.ok(!warnings.some(warning => warning.includes("lib/main.js")));
});

test("collectInitEvidence gathers verified repository evidence", () => {
  const root = fixtureWorkspace();
  const evidence = collectInitEvidence(root);
  assert.equal(evidence.workspaceRoot, root);
  assert.deepEqual(Object.keys(evidence.packageScripts), ["test", "lint", "build"]);
  assert.ok(evidence.directories.includes("lib"));
  assert.ok(evidence.directories.includes("test"));
  assert.ok(evidence.configFiles.includes("package.json"));
  assert.ok(evidence.inspectedFiles.includes("package.json"));
});

test("prepareInitPreview returns an update preview when AGENTS.md exists", () => {
  const root = fixtureWorkspace();
  const existing = "# Project Overview\n\nExisting custom rules.\n";
  writeFileSync(join(root, "AGENTS.md"), existing);
  const evidence = collectInitEvidence(root);
  const content = JSON.stringify({
    workspaceRoot: root,
    generatedMarkdown: "# Project Overview\n\nGenerated overview.\n\n# Development Commands\n\nRun `npm run test`.",
    warnings: [],
    evidenceSummary: "ok",
  });
  const preview = prepareInitPreview({ content, evidence });
  assert.equal(preview.ok, true);
  assert.equal(preview.existing, existing);
  assert.ok(preview.existingPath.endsWith("AGENTS.md"));
  assert.ok(preview.sectionCount >= 2);
});

test("prepareInitPreview reports validation failures", () => {
  const root = fixtureWorkspace();
  const evidence = collectInitEvidence(root);
  const content = JSON.stringify({ workspaceRoot: root, generatedMarkdown: "no heading" });
  const preview = prepareInitPreview({ content, evidence });
  assert.equal(preview.ok, false);
});

test("mergeExistingContent preserves custom sections without duplicating generated ones", () => {
  const existing = [
    "# Project Overview",
    "",
    "Existing overview text.",
    "",
    "# Custom Team Rules",
    "",
    "- Never push directly to main.",
    "",
  ].join("\n");
  const generated = [
    "# Project Overview",
    "",
    "Generated overview text.",
    "",
    "# Development Commands",
    "",
    "Run `npm test`.",
    "",
  ].join("\n");
  const merged = mergeExistingContent(existing, generated);
  assert.ok(merged.includes("Generated overview text."));
  assert.ok(merged.includes("Never push directly to main."));
  assert.ok(merged.includes("Run `npm test`."));
  assert.equal(merged.match(/# Project Overview/g).length, 1);
  assert.equal(merged.match(/# Custom Team Rules/g).length, 1);
});

test("buildInitTaskPrompt embeds evidence and custom instructions", () => {
  const root = fixtureWorkspace();
  const evidence = collectInitEvidence(root);
  const prompt = buildInitTaskPrompt({
    previousEvidence: evidence,
    previousMarkdown: "# Old",
    customInstruction: "Document the deploy process.",
  });
  assert.ok(prompt.includes("repository_initialization"));
  assert.ok(prompt.includes("fixture-app"));
  assert.ok(prompt.includes("lib/main.js"));
  assert.ok(prompt.includes("Document the deploy process."));
  assert.ok(prompt.includes('"generatedMarkdown"'));
});

test("diffLines marks added and removed rows", () => {
  const rows = diffLines("# A\n\nsame\n", "# B\n\nsame\n");
  assert.ok(rows.some(row => row.type === "remove" && row.text === "# A"));
  assert.ok(rows.some(row => row.type === "add" && row.text === "# B"));
  assert.ok(rows.some(row => row.type === "same" && row.text === "same"));
});

test("init agent inspects with read-only tools and returns a structured result", async () => {
  const root = fixtureWorkspace();
  const registry = new Registry();
  for (const tool of builtinTools(root)) registry.register(tool);
  const readOnlyRegistry = registry.subset(INIT_TOOLS);
  readOnlyRegistry.register({
    name: "write",
    description: "write a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    async execute() {
      throw new Error("must never execute");
    },
  });

  const read = JSON.stringify({ tool: "read", args: { path: "package.json" } });
  const glob = JSON.stringify({ tool: "glob", args: { pattern: "lib/**", path: root } });
  const blockedWrite = JSON.stringify({ tool: "write", args: { path: "hacked.txt", content: "x" } });
  const answer = JSON.stringify({
    workspaceRoot: root,
    generatedMarkdown: "# Project Overview\n\nFixture app.\n\n# Development Commands\n\nRun `npm run test`.",
    warnings: [],
    evidenceSummary: "inspected fixture",
  });
  const responses = [read, glob, blockedWrite, answer];

  const agent = new Agent(readOnlyRegistry, {
    workspace: root,
    sessionId: "init-task-isolation",
    readOnly: true,
    chat: async (_messages, options) => {
      const response = responses.shift();
      if (response === undefined) throw new Error("Unexpected extra model turn");
      options.onToken?.(response);
      return response;
    },
  });

  const events = [];
  const streamed = [];
  for await (const event of agent.loop(buildInitTaskPrompt({ baseline: collectInitEvidence(root) }))) {
    events.push(event);
    if (event.type === "stream") streamed.push(event.token);
  }

  assert.equal(existsSync(join(root, "hacked.txt")), false);
  const blocked = events.find(event =>
    event.type === "tool-result"
    && event.tool === "write"
    && /read-only/i.test(event.result || "")
  );
  assert.ok(blocked, "mutation tools must be rejected as read-only");
  assert.ok(events.some(event => event.type === "tool-call" && event.tool === "read"));
  assert.ok(events.some(event => event.type === "tool-call" && event.tool === "glob"));

  const finalAnswer = streamed.join("");
  const parsed = parseInitResult(finalAnswer);
  assert.equal(parsed.ok, true);
  const preview = prepareInitPreview({ content: finalAnswer, evidence: collectInitEvidence(root) });
  assert.equal(preview.ok, true);
  assert.match(preview.markdown, /Project Overview/);
  assert.ok(preview.warnings.every(warning => !warning.includes("npm run test")));
});

test("a streamed Markdown response finishes and opens the preview", () => {
  const root = fixtureWorkspace();
  const evidence = collectInitEvidence(root);
  const scope = { runId: "run-1", turnId: "turn-1", taskEpoch: 1 };
  const markdown = "# Project Overview\n\nFixture app.\n\n# Development Commands\n\nRun `npm run test`.";
  let buffer = createResponseBuffer(scope);
  for (let offset = 0; offset < markdown.length; offset += 13) {
    buffer = appendResponseDelta(buffer, scope, markdown.slice(offset, offset + 13));
  }
  const committed = commitResponseBuffer(buffer, scope);
  assert.ok(committed.response, "the streamed response must be committed once");
  assert.match(committed.response.content, /^# Project Overview/);
  const repeated = commitResponseBuffer(committed.state, scope);
  assert.equal(repeated.response, null, "a second commit must not finalize again");

  const validating = initValidatingState({
    content: committed.response.content,
    evidence,
    workspaceRoot: root,
    generationId: 1,
  });
  assert.equal(validating.status, "validating");
  assert.ok(validating.generatedMarkdown.startsWith("# Project Overview"));
  assert.ok(validating.inspectedFiles.length > 0);
  assert.equal(validating.workspaceRoot, root);

  const prepared = prepareInitPreview({ content: validating.generatedMarkdown, evidence });
  assert.equal(prepared.ok, true);

  const preview = initPreviewState({
    prepared,
    evidence,
    workspaceRoot: validating.workspaceRoot,
    generationId: 1,
    mode: "create",
    proposedContent: prepared.markdown,
    existing: null,
    existingPath: prepared.existingPath,
  });
  assert.equal(preview.status, "previewing");
  assert.equal(preview.previewVisible, true);
  assert.equal(preview.generatedMarkdown, prepared.markdown);
  assert.ok(preview.wordCount > 0);
  assert.equal(preview.inspectedCount, validating.inspectedFiles.length);
});

test("plain Markdown opens the preview without JSON parsing", () => {
  const root = fixtureWorkspace();
  const markdown = "# Project Overview\n\nFixture app.\n\n# Development Commands\n\nRun `npm run test`.";
  const parsed = parseInitResult(markdown);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result.generatedMarkdown, markdown);
  const prepared = prepareInitPreview({ content: markdown, evidence: collectInitEvidence(root) });
  assert.equal(prepared.ok, true);
  assert.match(prepared.markdown, /^# Project Overview/);
});

test("fenced Markdown is extracted correctly", () => {
  const source = "```markdown\n# Project Overview\n\nDemo content.\n```";
  const parsed = parseInitResult(source);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result.generatedMarkdown, "# Project Overview\n\nDemo content.");
  const fenced = parseInitResult("Here is the file:\n\n```md\n# Project Overview\n\nDemo content.\n```");
  assert.equal(fenced.ok, true);
  assert.equal(fenced.result.generatedMarkdown, "# Project Overview\n\nDemo content.");
});

test("a normal agent finalizer cannot clear the initialization preview", () => {
  const root = fixtureWorkspace();
  const evidence = collectInitEvidence(root);
  const scope = { runId: "run-1", turnId: "turn-1", taskEpoch: 1 };
  const markdown = "# Project Overview\n\nFixture app.";
  let buffer = createResponseBuffer(scope);
  buffer = appendResponseDelta(buffer, scope, markdown);
  const committed = commitResponseBuffer(buffer, scope);
  const prepared = prepareInitPreview({ content: committed.response.content, evidence });
  assert.equal(prepared.ok, true);
  const preview = initPreviewState({
    prepared,
    evidence,
    workspaceRoot: root,
    generationId: 1,
    mode: "create",
    proposedContent: prepared.markdown,
    existing: null,
    existingPath: prepared.existingPath,
  });
  const cleaned = discardResponseBuffer(committed.state, scope);
  assert.equal(cleaned.finalCommitted, true);
  const after = prepareInitPreview({ content: committed.response.content, evidence });
  assert.equal(after.ok, true);
  assert.equal(preview.status, "previewing");
  assert.equal(preview.previewVisible, true);
});

test("a stale generation callback cannot open a preview", () => {
  assert.equal(initPreviewIsCurrent(3, 2), false);
  assert.equal(initPreviewIsCurrent(3, 3), true);
  assert.equal(initPreviewIsCurrent(3, undefined), true);
  assert.equal(initPreviewIsCurrent(3, 0), false);
});

test("invalid output enters a visible failed state", () => {
  assert.equal(parseInitResult("just some prose").ok, false);
  const prepared = prepareInitPreview({ content: "just some prose", evidence: null });
  assert.equal(prepared.ok, false);
  const failed = initFailedState({
    error: `Generated AGENTS.md could not be prepared. ${prepared.error}`,
    generationId: 1,
    evidence: null,
    workspaceRoot: "/tmp/demo",
  });
  assert.equal(failed.mode, "failed");
  assert.equal(failed.previewVisible, true);
  assert.match(failed.error, /^Generated AGENTS\.md could not be prepared\./);
});

test("confirm writes AGENTS.md atomically", () => {
  const root = fixtureWorkspace();
  const path = join(root, "AGENTS.md");
  assert.equal(existsSync(path), false);
  writeAtomicFile("# Project Overview\n\nFixture app.", path);
  assert.equal(existsSync(path), true);
  assert.match(readFileSync(path, "utf-8"), /^# Project Overview/);
});
