const STATUSES = new Set(["pending", "in_progress", "completed", "cancelled"]);

export const todoWriteTool = {
  name: "todowrite",
  description: "Create or update the structured task list for the current session.",
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
          required: ["content", "status"],
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
      const content = String(todo?.content || "").trim();
      const status = String(todo?.status || "");
      if (!content) throw new Error(`Todo ${index + 1} requires content.`);
      if (!STATUSES.has(status)) throw new Error(`Todo ${index + 1} has an invalid status.`);
      return { content, status };
    });
    return {
      title: "Todos",
      output: normalized.length ? `Updated ${normalized.length} todos.` : "Cleared todos.",
      metadata: { todos: normalized },
    };
  },
};

