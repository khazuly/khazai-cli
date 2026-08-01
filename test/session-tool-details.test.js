import assert from "node:assert/strict";
import test from "node:test";
import { handleSessionCommand } from "../ui/session-commands.js";

function tool(id, path) {
  return {
    id,
    callId: `call-${id}`,
    type: "tool",
    tool: "read",
    args: { path },
    content: `File: ${path}\nLines: 1\nsource`,
    done: true,
    duration: 10,
  };
}

function detailContext(messages, requestValue = async () => "") {
  let inspected = null;
  return {
    context: {
      completedRef: { current: messages },
      requestValue,
      setInspectedTool: value => { inspected = value; },
    },
    inspected: () => inspected,
  };
}

test("details command selects a stable historical tool", async () => {
  const first = tool("first", "first.js");
  const second = tool("second", "second.js");
  let offered = [];
  const state = detailContext([first, second], async (_question, options, settings) => {
    offered = options;
    return settings.values[1].value;
  });

  await handleSessionCommand("/details", "", state.context);

  assert.equal(state.inspected()?.id, "first");
  assert.match(offered[0], /1\. Read · second\.js/);
  assert.match(offered[1], /2\. Read · first\.js/);
});

test("expand opens the latest tool and collapse closes the inspector", async () => {
  const state = detailContext([tool("first", "first.js"), tool("second", "second.js")]);

  await handleSessionCommand("/expand", "", state.context);
  assert.equal(state.inspected()?.id, "second");

  await handleSessionCommand("/collapse", "", state.context);
  assert.equal(state.inspected(), null);
});

test("details latest skips the selector and limits history choices to twenty", async () => {
  const messages = Array.from({ length: 25 }, (_, index) => tool(`tool-${index}`, `${index}.js`));
  let selectorCalls = 0;
  const state = detailContext(messages, async () => {
    selectorCalls++;
    return "";
  });

  await handleSessionCommand("/details", "latest", state.context);
  assert.equal(state.inspected()?.id, "tool-24");
  assert.equal(selectorCalls, 0);

  const selectorState = detailContext(messages, async (_question, options) => {
    assert.equal(options.length, 20);
    return "";
  });
  await handleSessionCommand("/details", "", selectorState.context);
});

test("allow-all command persists workspace state and restores normal prompts", async () => {
  const messages = [];
  const permissionValues = [];
  const session = { id: "session-1", permissionMode: "prompt" };
  let confirmation = null;
  const context = {
    agentRef: {
      current: {
        _permissionService: {
          setAllowAll: value => {
            permissionValues.push(value);
            return Promise.resolve();
          },
          permissionState: () => ({ allowAll: permissionValues.at(-1) === true, rules: [] }),
        },
      },
    },
    appendArchived: message => messages.push(message),
    autoApproveRef: { current: false },
    completedRef: { current: [] },
    currentModel: "big-cock",
    currentSessionRef: { current: session },
    sessionStoreRef: { current: { save: value => ({ ...value }) } },
    setInspectedTool() {},
    setThemeName() {},
    requestValue: async (question, options, settings) => {
      confirmation = { question, options, settings };
      return settings.values[1].value;
    },
    workspacePath: "/tmp/project",
  };

  await handleSessionCommand("/allow-all", "", context);
  assert.equal(confirmation.question, "Enable allow-all for this workspace?");
  assert.equal(confirmation.options[0], "Cancel");
  assert.equal(confirmation.options[1], "Enable allow-all");
  assert.deepEqual(permissionValues, [true]);
  assert.equal(messages.at(-1).content, "Allow-all enabled for /tmp/project.");

  await handleSessionCommand("/allow-all", "status", context);
  assert.equal(messages.at(-1).content, "Allow-all is enabled for /tmp/project.");

  await handleSessionCommand("/allow-all", "off", context);
  assert.deepEqual(permissionValues, [true, false]);
  assert.equal(messages.at(-1).content, "Allow-all disabled for /tmp/project.");

  await handleSessionCommand("/allow-all", "status", context);
  assert.equal(messages.at(-1).content, "Allow-all is disabled for /tmp/project.");
});
