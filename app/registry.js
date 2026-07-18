import { discoverRuntimeExtensions } from "./custom-tools.js";

const HOOKS = ["tool.definition", "tool.execute.before", "tool.execute.after"];

export class Registry {
  constructor() {
    this._tools = new Map();
    this._hooks = {
      "tool.definition": [],
      "tool.execute.before": [],
      "tool.execute.after": [],
    };
    this.errors = [];
  }
  register(t) {
    const name = String(t?.name || t?.id || "");
    if (!name) throw new TypeError("Invalid tool definition");
    this._tools.set(name, { ...t, name, id: t.id || name });
    return this;
  }
  get(name) { return this._tools.get(name); }
  list() { return Array.from(this._tools.values()); }

  on(event, handler) {
    if (!HOOKS.includes(event)) throw new Error(`Unknown registry hook: ${event}`);
    if (typeof handler !== "function") throw new TypeError("Registry hook must be a function");
    this._hooks[event].push(handler);
    return () => {
      const index = this._hooks[event].indexOf(handler);
      if (index >= 0) this._hooks[event].splice(index, 1);
    };
  }

  async trigger(event, context, value) {
    if (!HOOKS.includes(event)) throw new Error(`Unknown registry hook: ${event}`);
    let current = value;
    for (const handler of this._hooks[event]) {
      const next = await handler(context, current);
      if (next !== undefined) current = next;
    }
    return current;
  }

  async definitions(context = {}) {
    const result = [];
    for (const tool of this._tools.values()) {
      const value = await this.trigger("tool.definition", { ...context, toolID: tool.name }, {
        description: tool.description,
        parameters: tool.parameters,
      });
      result.push({ ...tool, ...value });
    }
    return result;
  }

  async load(workspace) {
    const discovered = await discoverRuntimeExtensions(workspace);
    for (const tool of discovered.tools) this.register(tool);
    for (const hook of discovered.hooks) {
      if (HOOKS.includes(hook.event)) this.on(hook.event, hook.handler);
      else discovered.errors.push({ path: hook.path, error: `Unknown plugin hook: ${hook.event}` });
    }
    this.errors = discovered.errors;
    return this;
  }

  subset(names = ["*"]) {
    if (names.includes("*")) return this;
    const registry = new Registry();
    const matches = (pattern, value) => {
      const expression = String(pattern)
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
      return new RegExp(`^${expression}$`, "i").test(value);
    };
    for (const tool of this._tools.values()) {
      if (names.some(pattern => matches(pattern, tool.name))) registry.register(tool);
    }
    for (const [event, handlers] of Object.entries(this._hooks)) {
      for (const handler of handlers) registry.on(event, handler);
    }
    return registry;
  }

  buildPromptBlock() {
    const lines = ["Available tools:"];
    for (const t of this._tools.values()) {
      lines.push(`\n## ${t.name}`, t.description);
      if (t.parameters) lines.push(`Parameters: ${JSON.stringify(t.parameters, null, 2)}`);
    }
    return lines.join("\n");
  }
} // Fixed async code handling
