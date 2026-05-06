import type { SystemPromptDefinition } from "./prompt.types";

export const structuredOutputPrompt: SystemPromptDefinition = {
  name: "structured-output-format",
  version: "1.0.0",
  purpose: "Provider-neutral instruction for returning schema-conformant JSON.",
  system: "Return only valid JSON matching schema {schemaName}.",
};

export function withStructuredOutputInstruction(system: string, schemaName: string) {
  return `${system}\n${structuredOutputPrompt.system.replace("{schemaName}", schemaName)}`;
}

export function buildStructuredOutputUserPrompt(input: {
  system: string;
  user: string;
  schemaName: string;
}) {
  return [
    input.system,
    input.user,
    structuredOutputPrompt.system.replace("{schemaName}", input.schemaName),
  ].join("\n\n");
}
