import type { SystemPromptDefinition } from "./prompt.types";

export const jsonRepairPrompt: SystemPromptDefinition = {
  name: "json-repair",
  version: "1.0.0",
  purpose: "Repair malformed JSON output without adding unsupported facts.",
  system: [
    "Repair malformed JSON so it validates against the requested schema.",
    "Preserve the original meaning and do not add unsupported facts.",
    "Return compact JSON only, without markdown fences or commentary.",
  ].join("\n"),
};
