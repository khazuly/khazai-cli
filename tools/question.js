import { createInterface } from "node:readline";

export const questionTool = {
  name: "question",
  description: "Ask the user a question.",
  parameters: { type: "object", properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" } } }, required: ["question"] },
  async execute({ question, options }) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
      rl.question(Array.isArray(options) ? `${question} [${options.join("/")}] ` : `${question} `, a => { rl.close(); resolve(a.trim()); });
    });
  },
};
