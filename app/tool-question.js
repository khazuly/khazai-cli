export function normalizeQuestionRequest(args = {}) {
  const seen = new Set();
  let recommendationUsed = false;
  const options = (Array.isArray(args.options) ? args.options : []).flatMap((option, index) => {
    const source = typeof option === "string" ? { label: option } : option || {};
    const label = String(source.label || "").trim();
    if (!label) return [];
    const id = String(source.id || `option-${index + 1}`).trim();
    if (seen.has(id)) return [];
    seen.add(id);
    const recommended = Boolean(source.recommended) && !recommendationUsed;
    recommendationUsed ||= recommended;
    return [{
      id,
      label,
      description: String(source.description || "").trim(),
      recommended,
    }];
  });
  if (args.allowCustomAnswer && !seen.has("custom")) {
    options.push({
      id: "custom",
      label: "Enter a custom answer",
      description: "Return to the prompt input and provide a custom response.",
      recommended: false,
      custom: true,
    });
  }
  return {
    questionId: String(args.questionId || "").trim(),
    question: String(args.question || "Please choose an option.").trim(),
    context: String(args.context || "").trim(),
    options,
    allowCustomAnswer: Boolean(args.allowCustomAnswer),
  };
}

