export const questionTool = {
  name: "question",
  description: "Ask the user a question.",
  parameters: { type: "object", properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" } } }, required: ["question"] },
  async execute() {
    // Agent handles this tool as an Ink event before execute() is reached.
    return "Interactive question requested.";
  },
};
