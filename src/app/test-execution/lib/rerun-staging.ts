import {
  TEST_EXECUTION_LAYER_HINTS,
  type LayerHint,
  type NaturalPlan,
  type NaturalStep,
} from "@/modules/test-execution/action-schema";

import type { DraftCase } from "./draft-storage";
import { buildNaturalPlan } from "./manual-step-form";

/**
 * The rerunnable subset of a case DTO. The optional fields let reports from
 * before lossless plan data was exposed fall back to their persisted step rows.
 */
export type RerunStagingCase = {
  title: string;
  sourceKind: string;
  azureTestCaseId?: string | null;
  plan?: NaturalPlan | null;
  steps: ReadonlyArray<{ action: unknown }>;
};

function actionToNaturalStep(action: unknown): NaturalStep {
  const value = action && typeof action === "object" ? action as Partial<NaturalStep> : {};
  const layerHint = value.layerHint;

  return {
    instruction: typeof value.instruction === "string" ? value.instruction : "",
    expectedResult: typeof value.expectedResult === "string" ? value.expectedResult : "",
    layerHint: TEST_EXECUTION_LAYER_HINTS.includes(layerHint as LayerHint) ? layerHint as LayerHint : "auto",
  };
}

/**
 * Converts a finished case to the editor's draft shape. New DTOs carry the
 * exact compiled natural plan; legacy DTOs can still be reconstructed from
 * the per-step action payloads.
 */
export function runCaseToDraftCase(caseDto: RerunStagingCase): DraftCase | null {
  const plan = caseDto.plan ?? buildNaturalPlan(caseDto.steps.map((step) => actionToNaturalStep(step.action)));
  if (!plan) return null;

  return {
    title: caseDto.title,
    sourceKind: caseDto.sourceKind === "azure_test_case" ? "azure_test_case" : "manual",
    azureTestCaseId: typeof caseDto.azureTestCaseId === "string" ? caseDto.azureTestCaseId : null,
    plan,
  };
}

export function runCasesToDraftCases(cases: ReadonlyArray<RerunStagingCase>): DraftCase[] {
  return cases.flatMap((caseDto) => {
    const draft = runCaseToDraftCase(caseDto);
    return draft ? [draft] : [];
  });
}
