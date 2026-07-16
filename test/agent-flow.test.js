import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent as RuntimeAgent } from "../app/agent.js";
import { fallbackIntentContract, normalizeIntentContract } from "../app/intent-resolver.js";
import { Registry } from "../app/registry.js";

const semanticFixtures = new Map([
  ["cari dokumentasi pairing code Baileys", { intent: "research", operation: "research", requiredEvidence: ["research"], domain: "web" }],
  ["ya buatkan", { intent: "change", operation: "create", requiredEvidence: ["mutation"], continuation: "accept_offer", modifiesFiles: true, createNewFiles: true }],
  ["ini https://www.npmjs.com/package/@whiskeysockets/baileys", { intent: "research", operation: "research", requiredEvidence: ["research"], targetUrl: "https://www.npmjs.com/package/@whiskeysockets/baileys", domain: "package" }],
  ["ada total berapa file di folder ini", { intent: "inspect", operation: "count_files", requiredEvidence: ["inspection"] }],
  ["buatkan kode obfuscator Python", { intent: "change", operation: "create", requiredEvidence: ["mutation"], modifiesFiles: true, createNewFiles: true, domain: "obfuscation" }],
  ["tapi gw mau kode hasil enkripsi tetap normal dan bisa dijalankan", { intent: "change", operation: "modify", requiredEvidence: ["mutation", "validation"], continuation: "refine_existing", modifiesFiles: true, validationRequested: true, domain: "obfuscation" }],
  ["hapus aja semua file yang ada du folder ini", { intent: "delete", operation: "clear_workspace", requiredEvidence: ["deletion"] }],
  ["hapus file obsolete.py", { intent: "delete", operation: "delete", requiredEvidence: ["deletion"] }],
  ["coba cek file apa aja yg ada di folder ini", { intent: "inspect", operation: "list_files", requiredEvidence: ["inspection"] }],
  ["coba cek file yg ada di folder ini", { intent: "inspect", operation: "list_files", requiredEvidence: ["inspection"] }],
  ["cek file yang ada", { intent: "inspect", operation: "list_files", requiredEvidence: ["inspection"] }],
  ["baca isi filenya", { intent: "inspect", operation: "inspect_code", requiredEvidence: ["inspection"] }],
  ["coba apakah file kode hasil obfuscate itu bisa dijalankan", { intent: "validate", operation: "validate", requiredEvidence: ["validation"], validationRequested: true, repairExistingOnFailure: true, domain: "obfuscation" }],
  ["coba cek apakah hasil obfuscate bisa dijalankan", { intent: "validate", operation: "validate", requiredEvidence: ["validation"], validationRequested: true, repairExistingOnFailure: true, domain: "obfuscation" }],
  ["Buatkan saya kode Python obfuscate untuk mengenkripsi file .py dan .js.", { intent: "change", operation: "create", requiredEvidence: ["mutation"], modifiesFiles: true, createNewFiles: true, domain: "obfuscation" }],
  ["Buat masing-masing 1 contoh .py dan .js lalu tes hasilnya.", { intent: "change", operation: "create", requiredEvidence: ["mutation", "validation"], requestedExtensions: [".py", ".js"], requiresPlan: true, modifiesFiles: true, validationRequested: true, createNewFiles: true, domain: "obfuscation" }],
  ["Buat contoh sample.py lalu tes obfuscation.", { intent: "change", operation: "create", requiredEvidence: ["mutation", "validation"], requestedExtensions: [".py"], requiresPlan: true, modifiesFiles: true, validationRequested: true, createNewFiles: true, domain: "obfuscation" }],
  ["maksudnya?", { intent: "answer", operation: "answer" }],
  ["git push perubahan ke repo khazuly/khazai-cli", { intent: "change", operation: "git", requiredEvidence: ["mutation"], domain: "git" }],
]);

async function resolveTestIntent({ input }) {
  return normalizeIntentContract(semanticFixtures.get(input) || fallbackIntentContract(input), input);
}

class Agent extends RuntimeAgent {
  constructor(registry, options = {}) {
    super(registry, { intentResolver: resolveTestIntent, ...options });
  }
}

function scriptedChat(responses) {
  let index = 0;
  return async (_messages, options) => {
    const response = responses[index++];
    if (response === undefined) throw new Error("Unexpected extra Claude turn");
    for (let offset = 0; offset < response.length; offset += 11) {
      options.onToken?.(response.slice(offset, offset + 11));
    }
    return response;
  };
}

test("incomplete streamed Markdown is continued before the final response", async () => {
  const contexts = [];
  const responses = [
    "Hello! I'm a coding agent ready to help you with:\n\n- File operations (read, write, edit)\n- **Search",
    " capabilities** (glob and grep)\n- Shell commands",
  ];
  const agent = new Agent(new Registry(), {
    model: "claude",
    workspace: "/tmp/incomplete-prose-test",
    chat: async (messages, options) => {
      contexts.push(messages.map(message => message.content).join("\n"));
      const response = responses.shift();
      options.onToken?.(response);
      return response;
    },
  });
  const events = [];
  for await (const event of agent.loop("helo")) events.push(event);

  const visible = events.filter(event => event.type === "stream").map(event => event.token).join("");
  assert.equal(contexts.length, 2);
  assert.match(contexts[1], /ended mid-content/i);
  assert.equal(events.filter(event => event.type === "stream-end").length, 1);
  assert.equal((visible.match(/Hello!/g) || []).length, 1);
  assert.match(visible, /- Search capabilities \(glob and grep\)/);
  assert.match(visible, /- Shell commands$/);
});

test("broken streamed tool calls recover with a smaller valid action without exposing internals", async () => {
  const contexts = [];
  const writes = [];
  const registry = new Registry();
  registry.register({
    name: "write",
    description: "write a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    async execute(args) { writes.push(args); return `Written ${args.path}`; },
  });
  const responses = [
    '{"tool":"write","args":{"path":"large.py","content":"' + "x".repeat(7000),
    '{"tool":"write","args":{"path":}}',
    '{"tool":"does-not-exist","args":{}}',
    '{"tool":"write","args":{"path":"large.py"}}',
    JSON.stringify({ tool: "write", args: { path: "small.py", content: "print('ok')\n" } }),
    "Selesai: file kecil sudah dibuat.",
  ];
  const agent = new Agent(registry, {
    workspace: "/tmp/tool-recovery-test",
    chat: async (messages, options) => {
      contexts.push(messages.map(message => message.content).join("\n"));
      const response = responses.shift();
      options.onToken?.(response);
      return response;
    },
  });
  const events = [];
  for await (const event of agent.loop("buatkan kode obfuscator Python")) events.push(event);

  assert.deepEqual(writes, [{ path: "/tmp/tool-recovery-test/small.py", content: "print('ok')\n", _agentWorkspace: "/tmp/tool-recovery-test" }]);
  assert.deepEqual(events.filter(event => event.type === "tool-call").map(event => event.tool), ["write"]);
  assert.equal(events.some(event => event.type === "error"), false);
  assert.equal(events.some(event => /unparseable|truncated before its JSON/i.test(event.content || "")), false);
  assert.match(contexts[1], /cut off|one operation only/i);
  assert.match(contexts[2], /malformed/i);
  assert.match(contexts[3], /does not exist/i);
  assert.match(contexts[4], /required argument/i);
  assert.equal(contexts.some(context => context.includes("x".repeat(100))), false, "invalid payload must not enter history");
});

test("accepting a researched implementation offer blocks another fetch cycle", async () => {
  let webExecutions = 0;
  let writes = 0;
  const contexts = [];
  const registry = new Registry();
  registry.register({
    name: "web",
    description: "fetch",
    parameters: { type: "object", properties: {} },
    async execute() {
      webExecutions++;
      return "Baileys documentation: pairing code uses requestPairingCode().";
    },
  });
  registry.register({
    name: "write",
    description: "write",
    parameters: { type: "object", properties: {} },
    async execute(args) {
      writes++;
      return `Written ${args.path}`;
    },
  });
  const responses = [
    JSON.stringify({ tool: "web", args: { url: "https://baileys.wiki/docs/intro" } }),
    "Saya sudah memeriksa dokumentasi Baileys. Apakah Anda ingin saya membuat contoh kode implementasi pairing code dengan Baileys?",
    JSON.stringify({ tool: "web", args: { url: "https://baileys.wiki/docs/intro" } }),
    JSON.stringify({ tool: "write", args: { path: "pairing.js", content: "const pairingCode = true;\n" } }),
    "Implementasi pairing code sudah dibuat.",
  ];
  const agent = new Agent(registry, {
    model: "claude",
    workspace: "/tmp/contextual-offer-test",
    chat: async (messages, options) => {
      contexts.push(messages.map(message => message.content).join("\n"));
      const response = responses.shift();
      options.onToken?.(response);
      return response;
    },
  });

  for await (const _event of agent.loop("cari dokumentasi pairing code Baileys")) {}
  const events = [];
  for await (const event of agent.loop("ya buatkan")) events.push(event);

  assert.equal(webExecutions, 1);
  assert.equal(writes, 1);
  assert.deepEqual(events.filter(event => event.type === "tool-call").map(event => event.tool), ["write"]);
  assert.match(contexts[2], /Accepted implementation offer:.*pairing code/i);
  assert.match(contexts[3], /research phase is already complete/i);
  assert.equal(events.some(event => event.type === "error"), false);
});

test("resolved package README prevents another web research cycle", async () => {
  let webExecutions = 0;
  let searchExecutions = 0;
  const registry = new Registry();
  registry.register({
    name: "web",
    description: "fetch",
    parameters: { type: "object", properties: {} },
    async execute() {
      webExecutions++;
      return [
        "Title: @whiskeysockets/baileys - npm",
        "Registry: https://registry.npmjs.org/%40whiskeysockets%2Fbaileys/latest",
        "## README",
        "Use requestPairingCode().",
      ].join("\n");
    },
  });
  registry.register({
    name: "websearch",
    description: "search",
    parameters: { type: "object", properties: {} },
    async execute() {
      searchExecutions++;
      return "This search must not execute";
    },
  });
  const responses = [
    JSON.stringify({ tool: "web", args: { url: "https://www.npmjs.com/package/@whiskeysockets/baileys" } }),
    JSON.stringify({ tool: "websearch", args: { query: "Baileys pairing code" } }),
    "Dokumentasi package ditemukan. Gunakan requestPairingCode() untuk membuat pairing code.",
  ];
  const agent = new Agent(registry, {
    model: "claude",
    workspace: "/tmp/npm-doc-loop-test",
    chat: scriptedChat(responses),
  });
  const events = [];
  for await (const event of agent.loop("ini https://www.npmjs.com/package/@whiskeysockets/baileys")) events.push(event);

  assert.equal(webExecutions, 1);
  assert.equal(searchExecutions, 0);
  assert.deepEqual(events.filter(event => event.type === "tool-call").map(event => event.tool), ["web"]);
  assert.match(events.filter(event => event.type === "stream").map(event => event.token).join(""), /requestPairingCode/);
  assert.equal(events.some(event => event.type === "error"), false);
});

test("read-only tool preamble is streamed before its tool call", async () => {
  const registry = new Registry();
  registry.register({
    name: "bash",
    description: "shell",
    parameters: { type: "object", properties: {} },
    async execute() { return "Exit: 0\n9"; },
  });
  const preamble = "I'll count the files for you.\n\n";
  const responses = [
    preamble + JSON.stringify({ tool: "bash", args: { command: "find . -type f | wc -l" } }),
  ];
  const agent = new Agent(registry, {
    workspace: "/tmp/preamble-guard-test",
    chat: scriptedChat(responses),
  });
  const events = [];
  for await (const event of agent.loop("ada total berapa file di folder ini")) events.push(event);

  assert.equal(events.some(event => event.type === "stream"), true);
  assert.deepEqual(events.filter(event => event.type === "tool-call").map(event => event.tool), ["bash"]);
  assert.equal(events.filter(event => event.type === "answer").length, 1);
  assert.equal(events.find(event => event.type === "answer")?.content, "There are 9 files in /tmp/preamble-guard-test.");
});

test("implementation refinement inherits mutation context and shows tool preamble", async () => {
  const registry = new Registry();
  registry.register({
    name: "write",
    description: "write",
    parameters: { type: "object", properties: {} },
    async execute(args) { return `Written ${args.path}`; },
  });
  registry.register({
    name: "bash",
    description: "shell",
    parameters: { type: "object", properties: {} },
    async execute() { return "Exit: 0\nrunnable output verified"; },
  });
  const responses = [
    JSON.stringify({ tool: "write", args: { path: "obfuscator.py", content: "print('v1')\n" } }),
    "Created the first implementation.",
    "I'll update the implementation.\n" + JSON.stringify({
      tool: "write",
      args: { path: "obfuscator.py", content: "print('runnable obfuscated output')\n" },
    }),
    JSON.stringify({ tool: "bash", args: { command: "python3 obfuscator.py" } }),
    "Updated the implementation.",
  ];
  const agent = new Agent(registry, {
    workspace: "/tmp/mutation-continuation-test",
    chat: scriptedChat(responses),
  });
  for await (const _event of agent.loop("buatkan kode obfuscator Python")) {}
  const events = [];
  for await (const event of agent.loop("tapi gw mau kode hasil enkripsi tetap normal dan bisa dijalankan")) events.push(event);

  assert.deepEqual(events.filter(event => event.type === "tool-call").map(event => event.tool), ["write", "bash"]);
  assert.match(events.filter(event => event.type === "stream").map(event => event.token).join(""), /Updated the implementation/);
  assert.equal(events.some(event => event.type === "error"), false);
});

test("explicit clear-folder request executes once and cannot finish from unsupported prose", async () => {
  const registry = new Registry();
  const executions = [];
  registry.register({
    name: "bash",
    description: "shell",
    parameters: { type: "object", properties: {} },
    async execute(args) {
      executions.push(args);
      return "Exit: 0\n";
    },
  });
  const agent = new Agent(registry, {
    model: "claude",
    workspace: "/tmp/test-khazai",
    chat: async () => {
      throw new Error("An explicit clear request must not depend on an LLM response");
    },
  });
  const events = [];
  for await (const event of agent.loop("hapus aja semua file yang ada du folder ini")) events.push(event);

  assert.equal(executions.length, 1);
  assert.equal(executions[0].workdir, "/tmp/test-khazai");
  assert.match(executions[0].command, /-mindepth 1 -maxdepth 1/);
  assert.match(executions[0].command, /-exec rm -rf/);
  assert.deepEqual(events.filter(event => event.type === "tool-call").map(event => event.tool), ["bash"]);
  assert.match(events.find(event => event.type === "answer")?.content || "", /verified empty/);
  assert.equal(events.some(event => event.type === "thinking"), false);
});

test("simple file listing uses one deterministic glob without redundant shell inspection", async () => {
  const registry = new Registry();
  let executions = 0;
  registry.register({
    name: "glob",
    description: "glob",
    parameters: { type: "object", properties: {} },
    async execute(args) {
      executions++;
      assert.equal(args.path, "/tmp/test-khazai");
      return "Found 3:\nREADME.md\nobfuscator.py\nsample.js";
    },
  });
  const agent = new Agent(registry, {
    workspace: "/tmp/test-khazai",
    chat: async () => {
      throw new Error("A simple file listing must not depend on the model selecting a tool");
    },
  });
  const events = [];
  for await (const event of agent.loop("coba cek file apa aja yg ada di folder ini")) events.push(event);

  assert.equal(executions, 1);
  assert.deepEqual(events.filter(event => event.type === "tool-call").map(event => event.tool), ["glob"]);
  assert.match(events.find(event => event.type === "answer")?.content || "", /Found 3 files/);
  assert.equal(events.some(event => event.type === "thinking"), false);
});

test("empty file listing returns a deterministic English answer", async () => {
  const registry = new Registry();
  registry.register({
    name: "glob",
    description: "glob",
    parameters: { type: "object", properties: {} },
    async execute() { return 'No files matching "*" in /tmp/test-khazai'; },
  });
  const agent = new Agent(registry, {
    workspace: "/tmp/test-khazai",
    chat: async () => { throw new Error("Empty file listing must be formatted locally"); },
  });
  const events = [];
  for await (const event of agent.loop("coba cek file yg ada di folder ini")) events.push(event);

  assert.deepEqual(events.filter(event => event.type === "tool-call").map(event => event.tool), ["glob"]);
  assert.equal(
    events.find(event => event.type === "answer")?.content,
    "The folder /tmp/test-khazai is empty. There are no files inside it.",
  );
  assert.equal(events.some(event => /No files matching/.test(event.content || "")), false);
});

test("specific deletion cannot be reported complete before a destructive tool succeeds", async () => {
  const registry = new Registry();
  registry.register({
    name: "bash",
    description: "shell",
    parameters: { type: "object", properties: {} },
    async execute() { return "Exit: 0\n"; },
  });
  const responses = [
    "Selesai.",
    JSON.stringify({ tool: "bash", args: { command: "rm -f obsolete.py" } }),
    "Selesai.",
  ];
  const contexts = [];
  const agent = new Agent(registry, {
    workspace: "/tmp/specific-delete-test",
    chat: async (messages, options) => {
      contexts.push(messages.map(message => message.content).join("\n"));
      const response = responses.shift();
      options.onToken?.(response);
      return response;
    },
  });
  const events = [];
  for await (const event of agent.loop("hapus file obsolete.py")) events.push(event);

  assert.match(contexts[1], /Recommended action: perform the requested deletion command safely/);
  assert.doesNotMatch(contexts[1], /Missing evidence|required execution evidence|successful workspace change/i);
  assert.deepEqual(events.filter(event => event.type === "tool-call").map(event => event.tool), ["bash"]);
  assert.match(events.filter(event => event.type === "stream").map(event => event.token).join(""), /Selesai/);
  assert.equal(events.some(event => event.type === "error"), false);
});

test("workspace diagnosis cannot finish before inspection evidence exists", async () => {
  const registry = new Registry();
  registry.register({
    name: "analyze",
    description: "analyze",
    parameters: { type: "object", properties: {} },
    async execute() { return "Analysis target: app.js\nSyntax: line 4 is invalid"; },
  });
  const responses = [
    "The syntax error is on line 4.",
    JSON.stringify({ tool: "analyze", args: { path: "app.js" } }),
    "The syntax error is on line 4.",
  ];
  const contexts = [];
  const agent = new Agent(registry, {
    workspace: "/tmp/diagnosis-evidence-test",
    chat: async (messages, options) => {
      contexts.push(messages.map(message => message.content).join("\n"));
      const response = responses.shift();
      options.onToken?.(response);
      return response;
    },
  });
  const events = [];
  for await (const event of agent.loop("analyze the bug in app.js")) events.push(event);

  assert.match(contexts[1], /Recommended action: perform the relevant read, search, or inspection/);
  assert.doesNotMatch(contexts[1], /Missing evidence|required execution evidence|successful workspace change/i);
  assert.deepEqual(events.filter(event => event.type === "tool-call").map(event => event.tool), ["analyze"]);
  assert.equal(events.filter(event => event.type === "stream-end").length, 1);
  assert.match(events.filter(event => event.type === "stream").map(event => event.token).join(""), /line 4/);
});

test("failed action evidence triggers a changed recovery action before completion", async () => {
  const registry = new Registry();
  const commands = [];
  registry.register({
    name: "bash",
    description: "shell",
    parameters: { type: "object", properties: {} },
    async execute(args) {
      commands.push(args.command);
      return commands.length === 1 ? "Exit: 1\ndependency conflict" : "Exit: 0\ninstalled";
    },
  });
  const responses = [
    JSON.stringify({ tool: "bash", args: { command: "npm install example" } }),
    "Installed successfully.",
    JSON.stringify({ tool: "bash", args: { command: "npm install example --legacy-peer-deps" } }),
    "Installed successfully.",
  ];
  const contexts = [];
  const agent = new Agent(registry, {
    workspace: "/tmp/recovery-evidence-test",
    chat: async (messages, options) => {
      contexts.push(messages.map(message => message.content).join("\n"));
      const response = responses.shift();
      options.onToken?.(response);
      return response;
    },
  });
  const events = [];
  for await (const event of agent.loop("install package example in this project")) events.push(event);

  assert.deepEqual(commands, ["npm install --prefix . example", "npm install --prefix . example --legacy-peer-deps"]);
  assert.match(contexts[2], /Recommended action: inspect the target and apply a minimal targeted edit/);
  assert.doesNotMatch(contexts[2], /Missing evidence|required execution evidence|successful workspace change/i);
  assert.equal(events.filter(event => event.type === "tool-call").length, 2);
  assert.match(events.filter(event => event.type === "stream").map(event => event.token).join(""), /Installed successfully/);
});

test("validation follow-up runs the existing artifact before allowing file changes", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-validate-first-"));
  writeFileSync(join(workspace, "obfuscate.py"), "def obfuscate(code):\n    return code\n");
  writeFileSync(join(workspace, "example_obfuscated.py"), "print('works')\n");
  let writes = 0;
  let runs = 0;
  const registry = new Registry();
  registry.register({
    name: "write",
    description: "write",
    parameters: { type: "object", properties: {} },
    async execute() { writes++; return "Written"; },
  });
  registry.register({
    name: "bash",
    description: "shell",
    parameters: { type: "object", properties: {} },
    async execute() { runs++; return "Exit: 0\nworks"; },
  });
  const responses = [
    JSON.stringify({ tool: "write", args: { path: "obfuscate.py", content: "print('replacement')\n" } }),
    JSON.stringify({ tool: "bash", args: { command: "python3 example_obfuscated.py" } }),
    "The existing obfuscated file runs successfully.",
  ];
  const contexts = [];
  const agent = new Agent(registry, {
    workspace,
    chat: async (messages, options) => {
      contexts.push(messages.map(message => message.content).join("\n"));
      const response = responses.shift();
      options.onToken?.(response);
      return response;
    },
  });

  try {
    const events = [];
    for await (const event of agent.loop("coba apakah file kode hasil obfuscate itu bisa dijalankan")) events.push(event);

    assert.equal(writes, 0);
    assert.equal(runs, 1);
    assert.match(contexts[1], /Run the existing artifact first/);
    assert.deepEqual(events.filter(event => event.type === "tool-call").map(event => event.tool), ["bash"]);
    assert.match(events.filter(event => event.type === "stream").map(event => event.token).join(""), /runs successfully/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("failed validation repairs an inspected existing implementation without replacing it", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "khazai-repair-existing-"));
  const sourcePath = join(workspace, "obfuscate.py");
  writeFileSync(sourcePath, "class PythonObfuscator:\n    def obfuscate(self):\n        return \"bad\"\n");
  writeFileSync(join(workspace, "example_obfuscated.py"), "this is invalid python\n");
  let runCount = 0;
  let mutationCount = 0;
  const registry = new Registry();
  registry.register({
    name: "bash",
    description: "shell",
    parameters: { type: "object", properties: {} },
    async execute() {
      runCount++;
      return runCount === 1 ? "Exit: 1\nSyntaxError: invalid syntax" : "Exit: 0\nworks";
    },
  });
  registry.register({
    name: "read",
    description: "read",
    parameters: { type: "object", properties: {} },
    async execute(args) { return readFileSync(args.path, "utf-8"); },
  });
  registry.register({
    name: "write",
    description: "write",
    parameters: { type: "object", properties: {} },
    async execute(args) { mutationCount++; writeFileSync(args.path, args.content); return "Written"; },
  });
  registry.register({
    name: "edit",
    description: "edit",
    parameters: { type: "object", properties: {} },
    async execute(args) {
      mutationCount++;
      const current = readFileSync(args.path, "utf-8");
      writeFileSync(args.path, current.replace(args.oldString, args.newString));
      return "Updated";
    },
  });
  const responses = [
    JSON.stringify({ tool: "bash", args: { command: "python3 example_obfuscated.py" } }),
    JSON.stringify({ tool: "write", args: { path: "obfuscate.py", content: "print('new unrelated implementation')\n" } }),
    JSON.stringify({ tool: "read", args: { path: "obfuscate.py" } }),
    JSON.stringify({ tool: "write", args: { path: "obfuscate.py", content: "print('new unrelated implementation')\n" } }),
    JSON.stringify({ tool: "edit", args: { path: "obfuscate.py", oldString: "return \"bad\"", newString: "return \"fixed\"" } }),
    JSON.stringify({ tool: "bash", args: { command: "python3 example_obfuscated.py" } }),
    "The existing implementation was repaired and its output now runs.",
  ];
  const agent = new Agent(registry, {
    workspace,
    chat: scriptedChat(responses),
  });

  try {
    const events = [];
    for await (const event of agent.loop("coba cek apakah hasil obfuscate bisa dijalankan")) events.push(event);

    assert.equal(runCount, 2);
    assert.equal(mutationCount, 1);
    assert.match(readFileSync(sourcePath, "utf-8"), /class PythonObfuscator/);
    assert.match(readFileSync(sourcePath, "utf-8"), /def obfuscate/);
    assert.match(readFileSync(sourcePath, "utf-8"), /return "fixed"/);
    assert.deepEqual(
      events.filter(event => event.type === "tool-call").map(event => event.tool),
      ["bash", "read", "edit", "bash"],
    );
    assert.equal(events.some(event => event.type === "error"), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("complex Claude flow streams one final answer only after validation", async () => {
  const plan = [
    "[ ] Create obfuscate.py with argparse",
    "[ ] Implement obfuscation using marshal",
    "[ ] Add syntax validation before and after obfuscation",
    "[ ] Implement error handling",
    "[ ] Create simple test cases",
    "[ ] Test obfuscation and verify execution",
  ].join("\n");
  const obfuscator = [
    "import argparse, marshal",
    "def main():",
    "    try:",
    "        compile('pass', '<source>', 'exec')",
    "    except Exception:",
    "        raise",
  ].join("\n");
  const responses = [
    plan,
    JSON.stringify({ tool: "write", args: { path: "obfuscate.py", content: obfuscator } }),
    JSON.stringify({ tool: "write", args: { path: "test_sample.py", content: "assert 1 + 1 == 2\n" } }),
    JSON.stringify({ tool: "bash", args: { command: "python3 -m py_compile obfuscate.py && python3 test_sample.py" } }),
    "Created and validated the Python obfuscator successfully.",
  ];
  const registry = new Registry();
  registry.register({
    name: "write",
    description: "write",
    parameters: { type: "object", properties: {} },
    async execute(args) { return `Written ${String(args.content).length} bytes to ${args.path}`; },
  });
  registry.register({
    name: "bash",
    description: "shell",
    parameters: { type: "object", properties: {} },
    async execute() { return "Exit: 0\nTests passed"; },
  });

  const agent = new Agent(registry, {
    model: "claude",
    workspace: "/tmp/agent-flow-test",
    chat: scriptedChat(responses),
  });
  const events = [];
  let pending = false;
  let prematureStreams = 0;
  for await (const event of agent.loop("Create a complete Python obfuscator with tests and validate it.")) {
    events.push(event);
    if (event.type === "plan") pending = true;
    if (event.type === "plan-update" && event.index === 5 && event.status === "done") pending = false;
    if (event.type === "stream" && pending) prematureStreams++;
  }

  const tools = events.filter(event => event.type === "tool-call").map(event => event.tool);
  const streamEnds = events.filter(event => event.type === "stream-end");
  const finalText = events.filter(event => event.type === "stream").map(event => event.token).join("");
  const finalIndex = events.findIndex(event => event.type === "stream-end");

  assert.deepEqual(tools, ["write", "write", "bash"]);
  assert.equal(prematureStreams, 0);
  assert.equal(streamEnds.length, 1);
  assert.match(finalText, /Created and validated/);
  assert.equal(events.slice(finalIndex + 1).some(event => event.type === "thinking" || event.type === "tool-call"), false);
  assert.deepEqual(
    events.filter(event => event.type === "plan-update" && event.status === "done").map(event => event.index),
    [0, 1, 2, 3, 4, 5],
  );
});

test("partial Claude tool generation is not retried for another timeout", async () => {
  const registry = new Registry();
  registry.register({
    name: "write",
    description: "write",
    parameters: { type: "object", properties: {} },
    async execute() { return "Written"; },
  });
  let calls = 0;
  let resets = 0;
  const agent = new Agent(registry, {
    workspace: "/tmp/agent-timeout-test",
    chat: async (_messages, options) => {
      calls++;
      options.onToken?.('{"tool":"write","args":{"path":"slow.py"');
      throw new Error("SSE chunk timeout");
    },
    resetSession: async () => { resets++; },
  });
  const events = [];
  for await (const event of agent.loop("Create slow.py")) events.push(event);

  assert.equal(calls, 1);
  assert.equal(resets, 0);
  assert.equal(events.some(event => event.type === "stream"), false);
  assert.equal(events.some(event => event.type === "error"), false);
  assert.equal(events.some(event => event.type === "answer"), false);
  assert.equal(events.some(event => event.type === "steering"), true);
  assert.equal(agent._pendingAction?.status, "recovering");
});

test("Claude timeout without tokens is not doubled by session retry", async () => {
  let calls = 0;
  let resets = 0;
  const agent = new Agent(new Registry(), {
    model: "claude",
    workspace: "/tmp/claude-timeout-test",
    chat: async () => {
      calls++;
      throw new Error("Request timed out");
    },
    resetSession: async () => { resets++; },
  });
  const events = [];
  for await (const event of agent.loop("Explain this folder")) events.push(event);

  assert.equal(calls, 1);
  assert.equal(resets, 0);
  assert.equal(events.some(event => event.type === "error"), false);
  assert.equal(events.some(event => event.type === "answer"), false);
  assert.equal(events.some(event => event.type === "steering"), true);
  assert.equal(agent._pendingAction?.status, "recovering");
});

test("context includes current request once and prunes stale tool payloads", () => {
  const agent = new Agent(new Registry(), { workspace: "/tmp/context-test" });
  agent._messages = [
    { role: "user", content: "old request" },
    { role: "assistant", content: '{"tool":"bash","args":{"command":"old command"}}' },
    { role: "user", content: "---TOOL RESULT: bash---\nlarge stale output" },
    { role: "assistant", content: "Old task completed." },
    { role: "user", content: "build the new obfuscator" },
    { role: "assistant", content: '{"tool":"write","args":{"path":"new.py"}}' },
    { role: "user", content: "---TOOL RESULT: write---\nWritten new.py" },
  ];
  agent._currentRequest = "build the new obfuscator";
  agent._requestStartIndex = 4;
  const combined = agent._buildContext().map(message => message.content).join("\n");

  assert.equal((combined.match(/build the new obfuscator/g) || []).length, 1);
  assert.doesNotMatch(combined, /old command|large stale output/);
  assert.match(combined, /Old task completed/);
  assert.match(combined, /Written new\.py/);
});

test("malformed tool recovery stays on the selected model and keeps the task pending", async () => {
  let calls = 0;
  const models = [];
  const registry = new Registry();
  registry.register({
    name: "write",
    description: "write",
    parameters: { type: "object", properties: {} },
    async execute() { throw new Error("Malformed calls must never execute"); },
  });
  const agent = new Agent(registry, {
    model: "claude",
    workspace: "/tmp/invalid-tool-test",
    chat: async (_messages, options) => {
      calls++;
      models.push(options.model);
      const malformed = '<function_calls>\n[{"tool":"write","args":{"path":"broken.py"}';
      options.onToken?.(malformed);
      return malformed;
    },
  });
  agent._config.maxTurns = 8;
  const events = [];
  for await (const event of agent.loop("Create broken.py")) events.push(event);

  assert.equal(calls, 8);
  assert.deepEqual(models, ["claude", "claude", "claude", "claude", "claude", "claude", "claude", "claude"]);
  assert.equal(events.some(event => event.type === "tool-call"), false);
  assert.equal(events.some(event => event.type === "error"), false);
  assert.equal(events.some(event => event.type === "answer"), false);
  assert.equal(events.some(event => event.type === "steering"), true);
  assert.equal(agent._pendingAction?.status, "recovering");
  assert.equal(events.some(event => /unparseable|truncated before/i.test(event.content || "")), false);
});

test("empty model responses receive detailed steering until a valid action arrives", async () => {
  let calls = 0;
  const registry = new Registry();
  registry.register({ name: "write", description: "write", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }, async execute() { return "Written"; } });
  const responses = ["", "", "", JSON.stringify({ tool: "write", args: { path: "recovered.js", content: "export const recovered = true;\n" } }), "Recovered the requested file."];
  const agent = new Agent(registry, {
    model: "claude",
    workspace: "/tmp/empty-response-test",
    chat: async () => {
      calls++;
      return responses.shift();
    },
  });
  const events = [];
  for await (const event of agent.loop("Create a file")) events.push(event);

  assert.equal(calls, 5);
  assert.equal(events.some(event => event.type === "error"), false);
  assert.equal(events.some(event => event.type === "steering"), true);
  assert.deepEqual(events.filter(event => event.type === "tool-call").map(event => event.tool), ["write"]);
  assert.equal(events.some(event => event.type === "answer"), false);
});

test("repeated successful glob uses cached evidence without exposing a hard-stop error", async () => {
  const registry = new Registry();
  let executions = 0;
  registry.register({
    name: "glob",
    description: "glob",
    parameters: { type: "object", properties: {} },
    async execute() {
      executions++;
      return "Found 3:\nobfuscator.py\ntest.py\nsample.js";
    },
  });
  const call = JSON.stringify({ tool: "glob", args: { pattern: "*", path: "/tmp/test-khazai" } });
  const agent = new Agent(registry, {
    model: "claude",
    workspace: "/tmp/test-khazai",
    chat: scriptedChat([call, call, call]),
  });
  const events = [];
  for await (const event of agent.loop("cek file yang ada")) events.push(event);

  assert.equal(executions, 1);
  assert.equal(events.filter(event => event.type === "tool-call").length, 1);
  assert.equal(events.some(event => event.type === "error"), false);
  const answer = events.find(event => event.type === "answer")?.content || "";
  assert.match(answer, /Found 3 files/);
  assert.equal(events.find(event => event.type === "tool-result")?.result.includes("obfuscator.py"), true);
  assert.doesNotMatch(answer, /requested three times|identical arguments|Stopped:/i);
});

test("a prior workspace listing is reused before reading file contents", async () => {
  const registry = new Registry();
  let globCalls = 0;
  let readCalls = 0;
  registry.register({
    name: "glob",
    description: "glob",
    parameters: { type: "object", properties: {} },
    async execute() {
      globCalls++;
      return "Found 2:\nobfuscate.py\nexample.py";
    },
  });
  registry.register({
    name: "read",
    description: "read",
    parameters: { type: "object", properties: {} },
    async execute(args) {
      readCalls++;
      assert.equal(args.path, "/tmp/reuse-listing/obfuscate.py");
      return "File: obfuscate.py\nLines: 1\ndef obfuscate(value): return value";
    },
  });
  const agent = new Agent(registry, {
    workspace: "/tmp/reuse-listing",
    chat: scriptedChat([
      JSON.stringify({ tool: "glob", args: { pattern: "*.py", path: "/tmp/reuse-listing" } }),
      JSON.stringify({ tool: "read", args: { path: "obfuscate.py" } }),
      "obfuscate.py contains the implementation; example.py is a sample input.",
    ]),
  });

  for await (const _event of agent.loop("cek file yang ada")) {}
  const events = [];
  for await (const event of agent.loop("baca isi filenya")) events.push(event);

  assert.equal(globCalls, 1, "the second request must reuse the existing listing");
  assert.equal(readCalls, 1);
  assert.deepEqual(events.filter(event => event.type === "tool-call").map(event => event.tool), ["read"]);
  assert.match(events.find(event => event.type === "stream")?.token || "", /obfuscate\.py contains/);
});

test("explicit Git push runs through the bash tool like OpenCode", async () => {
  const registry = new Registry();
  const commands = [];
  registry.register({
    name: "bash",
    description: "shell",
    parameters: { type: "object", properties: {} },
    async execute(args) {
      commands.push(args.command);
      return "Exit: 0\nTo github.com:khazuly/khazai-cli.git\n   abc123..def456  master -> master";
    },
  });
  const responses = [
    "I'll check the status first.",
    JSON.stringify({ tool: "bash", args: { command: "git status" } }),
    "Everything looks good. Pushing now.",
    JSON.stringify({ tool: "bash", args: { command: "git push origin HEAD" } }),
    "Push completed successfully.",
  ];
  const agent = new Agent(registry, {
    workspace: "/tmp/git-push-test",
    chat: scriptedChat(responses),
  });
  const events = [];
  for await (const event of agent.loop("git push perubahan ke repo khazuly/khazai-cli")) events.push(event);

  assert.ok(commands.includes("git push origin HEAD"));
  assert.equal(events.find(event => event.type === "answer")?.content, "Push completed successfully.");
});

test("interactive question events strip model markdown before rendering", async () => {
  const registry = new Registry();
  registry.register({
    name: "question",
    description: "question",
    parameters: { type: "object", properties: {} },
    async execute() { throw new Error("Question interaction must not execute as a normal tool"); },
  });
  const responses = [
    JSON.stringify({
      tool: "question",
      args: {
        question: "**What would you like me to do?**",
        options: ["**Create a file**", "`Explain this repository`"],
      },
    }),
    "Hello. How can I help?",
  ];
  const agent = new Agent(registry, {
    model: "claude",
    workspace: "/tmp/question-markdown-test",
    chat: scriptedChat(responses),
    questionHandler: async ({ options }) => options[0],
  });
  const events = [];
  for await (const event of agent.loop("hi")) events.push(event);

  const question = events.find(event => event.type === "question");
  assert.equal(question?.question, "What would you like me to do?");
  assert.deepEqual(question?.options, ["Create a file", "Explain this repository"]);
  assert.equal(events.some(event => /\*\*|`/.test(event.question || "")), false);
});

test("truncated write retries with the selected model and a detailed recovery request", async () => {
  const contexts = [];
  const models = [];
  const registry = new Registry();
  registry.register({
    name: "write",
    description: "write",
    parameters: { type: "object", properties: {} },
    async execute(args) { return `Written ${args.path}`; },
  });
  const responses = [
    '```json\n{"tool":"write","args":{"path":"app.py","content":"def unfinished():\\n',
    JSON.stringify({ tool: "write", args: { path: "app.py", content: "print('complete')\n" } }),
    "Created app.py.",
  ];
  const agent = new Agent(registry, {
    model: "claude",
    workspace: "/tmp/truncated-recovery-test",
    chat: async (messages, options) => {
      contexts.push(messages.map(message => message.content).join("\n"));
      models.push(options.model);
      const response = responses.shift();
      options.onToken?.(response);
      return response;
    },
  });
  const events = [];
  for await (const event of agent.loop("Create app.py")) events.push(event);

  assert.match(contexts[1], /internal tool-call recovery/i);
  assert.match(contexts[1], /one operation only/i);
  assert.deepEqual(models, ["claude", "claude", "claude"]);
  assert.deepEqual(events.filter(event => event.type === "tool-call").map(event => event.tool), ["write"]);
  assert.equal(events.some(event => event.type === "error"), false);
});

test("live-style flat read of a directory is normalized to glob", async () => {
  const registry = new Registry();
  registry.register({
    name: "read",
    description: "read",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    async execute() { throw new Error("directory read must be normalized before execution"); },
  });
  registry.register({
    name: "glob",
    description: "glob",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string" } },
    },
    async execute() { return "Found 3:\nobfuscator.py\ntest.py\nsample.js"; },
  });
  const models = [];
  const responses = [
    '{"tool":"read","path":"/tmp"}',
    '{"tool":"glob","args":{"pattern":"*","path":"/tmp"}}',
    "Found obfuscator.py, test.py, and sample.js.",
  ];
  const agent = new Agent(registry, {
    model: "claude",
    workspace: "/tmp",
    chat: async (_messages, options) => {
      models.push(options.model);
      const response = responses.shift();
      options.onToken?.(response);
      return response;
    },
  });
  const events = [];
  for await (const event of agent.loop("inspect the directory structure before explaining this repository")) events.push(event);

  assert.deepEqual(models, ["claude", "claude", "claude"]);
  assert.deepEqual(events.filter(event => event.type === "tool-call").map(event => event.tool), ["glob"]);
  assert.equal(events.some(event => event.type === "error"), false);
});

test("actionable Indonesian mutation hides option menus and performs the write", async () => {
  const registry = new Registry();
  registry.register({
    name: "write",
    description: "write",
    parameters: { type: "object", properties: {} },
    async execute(args) { return `Written ${args.path}`; },
  });
  const responses = [
    "Anda bisa memilih beberapa opsi:\n1. Buat obfuscator\n2. Upload file\n\nPilihan mana yang Anda inginkan?",
    JSON.stringify({ tool: "write", args: { path: "obfuscator.py", content: "import base64\n" } }),
    "The AES-256-CBC obfuscator has been created with a hardcoded key.",
  ];
  const agent = new Agent(registry, {
    workspace: "/tmp/actionable-mutation-test",
    chat: scriptedChat(responses),
  });
  const events = [];
  for await (const event of agent.loop("Buatkan saya kode Python obfuscate untuk mengenkripsi file .py dan .js.")) events.push(event);

  const visible = events.filter(event => event.type === "stream").map(event => event.token).join("");
  assert.deepEqual(events.filter(event => event.type === "tool-call").map(event => event.tool), ["write"]);
  assert.doesNotMatch(visible, /pilihan mana|AES-256-CBC|hardcoded/i);
  assert.match(visible, /Completed successfully/);
  assert.match(visible, /Base64.*not cryptographic encryption/i);
});

test("sample-and-test request cannot finish before every sample and validation", async () => {
  const registry = new Registry();
  registry.register({
    name: "write",
    description: "write",
    parameters: { type: "object", properties: {} },
    async execute(args) { return `Written ${args.path}`; },
  });
  registry.register({
    name: "bash",
    description: "shell",
    parameters: { type: "object", properties: {} },
    async execute() { return "Exit: 0\nPython and JavaScript outputs verified"; },
  });
  const responses = [
    JSON.stringify({ tool: "write", args: { path: "sample.py", content: "print('py')\n" } }),
    "Both samples are ready and tested.",
    JSON.stringify({ tool: "write", args: { path: "sample.js", content: "console.log('js');\n" } }),
    "Testing completed successfully.",
    JSON.stringify({ tool: "bash", args: { command: "python3 obfuscator.py sample.py sample.js && python3 sample_obfuscated.py && node sample_obfuscated.js" } }),
    "AES encryption passed for both files.",
  ];
  const agent = new Agent(registry, {
    workspace: "/tmp/sample-validation-test",
    chat: scriptedChat(responses),
  });
  const events = [];
  for await (const event of agent.loop("Buat masing-masing 1 contoh .py dan .js lalu tes hasilnya.")) events.push(event);

  assert.deepEqual(
    events.filter(event => event.type === "tool-call").map(event => event.tool),
    ["write", "write", "bash"],
  );
  const visible = events.filter(event => event.type === "stream").map(event => event.token).join("");
  assert.doesNotMatch(visible, /Both samples|Testing completed|AES encryption/i);
  assert.match(visible, /sample\.py/);
  assert.match(visible, /sample\.js/);
  assert.match(visible, /Validation passed/);
  assert.equal(events.some(event => event.type === "plan-update" && event.index === 0 && event.status === "skipped"), true);
});

test("dependency installation is not accepted as execution validation", async () => {
  const registry = new Registry();
  registry.register({
    name: "write",
    description: "write",
    parameters: { type: "object", properties: {} },
    async execute(args) { return `Written ${args.path}`; },
  });
  registry.register({
    name: "bash",
    description: "shell",
    parameters: { type: "object", properties: {} },
    async execute() { return "Exit: 0"; },
  });
  const responses = [
    JSON.stringify({ tool: "write", args: { path: "sample.py", content: "print('sample')\n" } }),
    JSON.stringify({ tool: "bash", args: { command: "pip install pycryptodome" } }),
    "Encryption test passed.",
    JSON.stringify({ tool: "bash", args: { command: "python3 obfuscator.py sample.py" } }),
    "Encryption test passed.",
  ];
  const agent = new Agent(registry, {
    workspace: "/tmp/install-is-not-test",
    chat: scriptedChat(responses),
  });
  const events = [];
  for await (const event of agent.loop("Buat contoh sample.py lalu tes obfuscation.")) events.push(event);

  assert.deepEqual(
    events.filter(event => event.type === "tool-call").map(event => event.tool),
    ["write", "bash", "bash"],
  );
  assert.match(events.filter(event => event.type === "stream").map(event => event.token).join(""), /Encryption test passed/);
  assert.equal(events.filter(event => event.type === "plan-update" && event.status === "done").length, 2);
});

test("auxiliary inspection does not fail or advance an active create todo", async () => {
  const registry = new Registry();
  registry.register({
    name: "read",
    description: "read",
    parameters: { type: "object", properties: {} },
    async execute() { return "File: existing.txt\ncontent"; },
  });
  registry.register({
    name: "write",
    description: "write",
    parameters: { type: "object", properties: {} },
    async execute(args) { return `Written ${args.path}`; },
  });
  const responses = [
    "[ ] Create the requested app.py file",
    JSON.stringify({ tool: "read", args: { path: "existing.txt" } }),
    JSON.stringify({ tool: "write", args: { path: "app.py", content: "print('done')\n" } }),
    "Created app.py.",
  ];
  const agent = new Agent(registry, {
    workspace: "/tmp/auxiliary-inspection-test",
    chat: scriptedChat(responses),
  });
  const events = [];
  for await (const event of agent.loop("Create app.py after checking the workspace.")) events.push(event);

  assert.deepEqual(events.filter(event => event.type === "tool-call").map(event => event.tool), ["read", "write"]);
  assert.deepEqual(
    events.filter(event => event.type === "plan-update").map(event => [event.index, event.status]),
    [[0, "running"], [0, "done"]],
  );
});

test("Indonesian explanation follow-up is read-only and blocks surprise writes", async () => {
  const registry = new Registry();
  registry.register({
    name: "write",
    description: "write",
    parameters: { type: "object", properties: {} },
    async execute() { throw new Error("Read-only follow-up must not write"); },
  });
  const responses = [
    JSON.stringify({ tool: "write", args: { path: "test.py", content: "print('unexpected')\n" } }),
    "Maksudnya, Base64 hanya encoding yang mudah dibalik dan bukan AES encryption.",
  ];
  const agent = new Agent(registry, {
    workspace: "/tmp/read-only-follow-up-test",
    chat: scriptedChat(responses),
  });
  const events = [];
  for await (const event of agent.loop("maksudnya?")) events.push(event);

  assert.equal(events.some(event => event.type === "tool-call"), false);
  assert.match(events.filter(event => event.type === "stream").map(event => event.token).join(""), /Base64 hanya encoding/);
});
