const STATUSES = new Set(["pending", "in_progress", "completed", "cancelled"]);

const STATUS_ALIASES = new Map([
  ["pending", "pending"],
  ["todo", "pending"],
  ["not started", "pending"],
  ["in_progress", "in_progress"],
  ["in-progress", "in_progress"],
  ["in progress", "in_progress"],
  ["running", "in_progress"],
  ["active", "in_progress"],
  ["completed", "completed"],
  ["complete", "completed"],
  ["done", "completed"],
  ["finished", "completed"],
  ["cancelled", "cancelled"],
  ["canceled", "cancelled"],
]);

export const todoWriteTool = {
  name: "todowrite",
  description: "Create or update the structured task list for the current session. Status is optional and advisory; plan progress is derived from tool evidence.",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string" },
            status: { type: "string", enum: [...STATUSES] },
          },
          required: ["content"],
          additionalProperties: false,
        },
      },
    },
    required: ["todos"],
    additionalProperties: false,
  },
  async execute({ todos }) {
    if (!Array.isArray(todos) || todos.length > 100) throw new Error("todos must contain at most 100 items.");
    const normalized = todos.map((todo, index) => {
      const content = String(todo?.content ?? todo?.description ?? todo?.title ?? "").trim();
      if (!content) throw new Error(`Todo ${index + 1} requires content.`);
      const rawStatus = String(todo?.status ?? "").trim().toLowerCase();
      const status = STATUS_ALIASES.get(rawStatus) || "pending";
      return { content, status };
    });
    return {
      title: "Todos",
      output: normalized.length ? `Updated ${normalized.length} todos.` : "Cleared todos.",
      metadata: { todos: normalized },
    };
  },
};
