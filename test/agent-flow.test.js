import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../app/agent.js";
import { Registry } from "../app/registry.js";

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
  assert.match(visible, /- \*\*Search capabilities\*\* \(glob and grep\)/);
  assert.match(visible, /- Shell commands$/);
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
      return "This fetch must not execute";
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

  assert.equal(webExecutions, 0);
  assert.equal(writes, 1);
  assert.deepEqual(events.filter(event => event.type === "tool-call").map(event => event.tool), ["write"]);
  assert.match(contexts[1], /Accepted implementation offer:.*pairing code/i);
  assert.match(contexts[2], /research phase is already complete/i);
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

test("read-only tool preamble is never streamed before its tool call", async () => {
  const registry = new Registry();
  registry.register({
    name: "bash",
    description: "shell",
    parameters: { type: "object", properties: {} },
    async execute() { return "Exit: 0\n9"; },
  });
  const preamble = "HASIL LAMA YANG TIDAK BOLEH TAMPIL\n\n```plain\nstale content\n```\n";
  const responses = [
    preamble + JSON.stringify({ tool: "bash", args: { command: "find . -type f | wc -l" } }),
  ];
  const agent = new Agent(registry, {
    workspace: "/tmp/preamble-guard-test",
    chat: scriptedChat(responses),
  });
  const events = [];
  for await (const event of agent.loop("ada total berapa file di folder ini")) events.push(event);

  assert.equal(events.some(event => event.type === "stream"), false);
  assert.deepEqual(events.filter(event => event.type === "tool-call").map(event => event.tool), ["bash"]);
  assert.equal(events.filter(event => event.type === "answer").length, 1);
  assert.equal(events.find(event => event.type === "answer")?.content, "Ada 9 file di /tmp/preamble-guard-test.");
  assert.equal(events.some(event => JSON.stringify(event).includes("HASIL LAMA")), false);
});

test("implementation refinement inherits mutation context and hides tool preamble", async () => {
  const registry = new Registry();
  registry.register({
    name: "write",
    description: "write",
    parameters: { type: "object", properties: {} },
    async execute(args) { return `Written ${args.path}`; },
  });
  const responses = [
    JSON.stringify({ tool: "write", args: { path: "obfuscator.py", content: "print('v1')\n" } }),
    "Created the first implementation.",
    "Implementasi lama yang tidak boleh tampil\n" + JSON.stringify({
      tool: "write",
      args: { path: "obfuscator.py", content: "print('runnable obfuscated output')\n" },
    }),
    "Updated the implementation.",
  ];
  const agent = new Agent(registry, {
    workspace: "/tmp/mutation-continuation-test",
    chat: scriptedChat(responses),
  });
  for await (const _event of agent.loop("buatkan kode obfuscator Python")) {}
  const events = [];
  for await (const event of agent.loop("tapi gw mau kode hasil enkripsi tetap normal dan bisa dijalankan")) events.push(event);

  assert.deepEqual(events.filter(event => event.type === "tool-call").map(event => event.tool), ["write"]);
  assert.equal(events.some(event => event.type === "stream" && /Implementasi lama/.test(event.token)), false);
  assert.match(events.filter(event => event.type === "stream").map(event => event.token).join(""), /Selesai/);
  assert.equal(events.some(event => event.type === "error"), false);
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
  assert.match(events.find(event => event.type === "error")?.content || "", /SSE chunk timeout/);
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
  assert.match(events.find(event => event.type === "error")?.content || "", /Request timed out/);
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

test("malformed tool recovery stays on the selected model before stopping", async () => {
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
  const events = [];
  for await (const event of agent.loop("Create broken.py")) events.push(event);

  assert.equal(calls, 3);
  assert.deepEqual(models, ["claude", "claude", "claude"]);
  assert.equal(events.some(event => event.type === "tool-call"), false);
  assert.match(events.find(event => event.type === "error")?.content || "", /selected model returned three consecutive/i);
});

test("two empty responses stop instead of looping silently", async () => {
  let calls = 0;
  const agent = new Agent(new Registry(), {
    model: "claude",
    workspace: "/tmp/empty-response-test",
    chat: async () => {
      calls++;
      return "";
    },
  });
  const events = [];
  for await (const event of agent.loop("Create a file")) events.push(event);

  assert.equal(calls, 2);
  assert.match(events.find(event => event.type === "error")?.content || "", /two empty responses/i);
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
  assert.match(answer, /Ditemukan 3 file/);
  assert.match(answer, /obfuscator\.py[\s\S]*test\.py[\s\S]*sample\.js/);
  assert.doesNotMatch(answer, /requested three times|identical arguments|Stopped:/i);
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

test("truncated write retries with the selected model and a bounded recovery request", async () => {
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

  assert.match(contexts[1], /recovery attempt 1/i);
  assert.match(contexts[1], /under 6000 source characters/);
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
  for await (const event of agent.loop("cek file yang ada di folder ini")) events.push(event);

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
  assert.match(visible, /Selesai/);
  assert.match(visible, /Base64.*bukan enkripsi/i);
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
  assert.match(visible, /Pengujian berhasil/);
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
  assert.match(events.filter(event => event.type === "stream").map(event => event.token).join(""), /Pengujian berhasil/);
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
