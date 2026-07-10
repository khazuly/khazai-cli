export class Registry {
  constructor() { this._tools = new Map(); }
  register(t) { this._tools.set(t.name, t); }
  get(name) { return this._tools.get(name); }
  list() { return Array.from(this._tools.values()); }

  buildPromptBlock() {
    const lines = ["Available tools:"];
    for (const t of this._tools.values()) {
      lines.push(`\n## ${t.name}`, t.description);
      if (t.parameters) lines.push(`Parameters: ${JSON.stringify(t.parameters, null, 2)}`);
    }
    return lines.join("\n");
  }
}
