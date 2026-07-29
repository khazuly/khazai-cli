export const thinkTool = {
  name: "think",
  description: "Publish concise operational progress while keeping private reasoning internal.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      activity: {
        type: "string",
        description: "Current factual operation without reasoning or evidence chains.",
        maxLength: 120,
      },
      target: {
        type: "string",
        description: "Current file, component, function, test, or operation.",
        maxLength: 160,
      },
      nextAction: {
        type: "string",
        description: "Next concrete operation without speculation.",
        maxLength: 160,
      },
      progress: {
        type: "string",
        description: "Optional numeric progress in X/Y form.",
        pattern: "^\\d+\\/\\d+$",
        maxLength: 16,
      },
    },
    required: ["activity"],
  },
  async execute() {
    return "Public activity updated.";
  },
};
