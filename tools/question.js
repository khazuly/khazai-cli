export const questionTool = {
  name: "question",
  description: "Ask one material question through a structured interactive selection.",
  parameters: {
    type: "object",
    properties: {
      questionId: { type: "string" },
      question: { type: "string" },
      context: { type: "string" },
      options: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            label: { type: "string" },
            description: { type: "string" },
            recommended: { type: "boolean" },
          },
          required: ["id", "label"],
          additionalProperties: false,
        },
      },
      allowCustomAnswer: { type: "boolean" },
    },
    required: ["question"],
    additionalProperties: false,
  },
  async execute() {
    return "Interactive question requested.";
  },
};
