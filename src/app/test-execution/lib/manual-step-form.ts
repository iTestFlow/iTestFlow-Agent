import {
  MAX_EXPECTED_RESULT_LENGTH,
  MAX_INSTRUCTION_LENGTH,
  NATURAL_PLAN_SCHEMA_VERSION,
  NaturalStepSchema,
  type NaturalPlan,
  type NaturalStep,
} from "@/modules/test-execution/action-schema";

/**
 * Small pure helpers behind the text-step editor: row model, validation, and
 * plan assembly for natural-language steps.
 */

export function emptyNaturalStep(): NaturalStep {
  return { instruction: "", expectedResult: "" };
}

export function validateNaturalStep(step: NaturalStep): string | null {
  const instruction = step.instruction.trim();
  if (!instruction) return "Describe what to do in this step.";
  if (instruction.length > MAX_INSTRUCTION_LENGTH) {
    return `Keep the instruction under ${MAX_INSTRUCTION_LENGTH} characters.`;
  }
  if (step.expectedResult.length > MAX_EXPECTED_RESULT_LENGTH) {
    return `Keep the expected result under ${MAX_EXPECTED_RESULT_LENGTH} characters.`;
  }
  return NaturalStepSchema.safeParse(step).success ? null : "This step is not valid.";
}

/** One-line label for step lists; the instruction IS the description. */
export function describeNaturalStep(step: NaturalStep, maxLength = 140): string {
  const instruction = step.instruction.trim() || "(empty step)";
  return instruction.length > maxLength ? `${instruction.slice(0, maxLength - 1)}…` : instruction;
}

export function buildNaturalPlan(steps: NaturalStep[]): NaturalPlan | null {
  const cleaned = steps
    .map((step) => ({ instruction: step.instruction.trim(), expectedResult: step.expectedResult.trim() }))
    .filter((step) => step.instruction.length > 0);
  if (cleaned.length === 0) return null;
  return { schemaVersion: NATURAL_PLAN_SCHEMA_VERSION, steps: cleaned };
}

/** Azure test-case steps map 1:1 into a natural plan — no compilation. */
export function azureStepsToNaturalPlan(
  steps: { action: string; expectedResult: string }[],
): NaturalPlan | null {
  return buildNaturalPlan(
    steps.map((step) => ({
      instruction: step.action.slice(0, MAX_INSTRUCTION_LENGTH),
      expectedResult: (step.expectedResult ?? "").slice(0, MAX_EXPECTED_RESULT_LENGTH),
    })),
  );
}
