import { describe, expect, it } from "vitest";

import type { NaturalPlan } from "@/modules/test-execution/action-schema";

import {
  runCaseToDraftCase,
  runCasesToDraftCases,
  type RerunStagingCase,
} from "./rerun-staging";

function caseDto(overrides: Partial<RerunStagingCase> = {}): RerunStagingCase {
  return {
    title: "Checkout completes",
    sourceKind: "manual",
    azureTestCaseId: null,
    plan: null,
    steps: [],
    ...overrides,
  };
}

describe("rerun staging", () => {
  it("prefers the DTO plan so layer hints are preserved losslessly", () => {
    const plan: NaturalPlan = {
      schemaVersion: "v2-natural",
      steps: [{ instruction: "Call the checkout endpoint", expectedResult: "201 Created", layerHint: "api" }],
    };

    const draft = runCaseToDraftCase(caseDto({
      sourceKind: "azure_test_case",
      azureTestCaseId: "12345",
      plan,
      steps: [{ action: { instruction: "This fallback must not be used", layerHint: "ui" } }],
    }));

    expect(draft).toEqual({
      title: "Checkout completes",
      sourceKind: "azure_test_case",
      azureTestCaseId: "12345",
      plan,
    });
  });

  it("rebuilds a legacy case from action payloads and normalizes its layer hint", () => {
    const draft = runCaseToDraftCase(caseDto({
      steps: [{ action: { instruction: "  Open checkout  ", expectedResult: "  It loads  " } }],
    }));

    expect(draft).toEqual({
      title: "Checkout completes",
      sourceKind: "manual",
      azureTestCaseId: null,
      plan: {
        schemaVersion: "v2-natural",
        steps: [{ instruction: "Open checkout", expectedResult: "It loads", layerHint: "auto" }],
      },
    });
  });

  it("drops cases without usable steps and treats unknown source kinds as manual", () => {
    const unusable = caseDto({
      sourceKind: "imported",
      azureTestCaseId: "987",
      steps: [{ action: { instruction: "   ", layerHint: "not-a-layer" } }, { action: null }],
    });
    const usable = caseDto({
      title: "Legacy import",
      sourceKind: "imported",
      azureTestCaseId: "987",
      steps: [{ action: { instruction: "Run it", layerHint: "not-a-layer" } }],
    });

    expect(runCaseToDraftCase(unusable)).toBeNull();
    expect(runCasesToDraftCases([unusable, usable])).toEqual([
      {
        title: "Legacy import",
        sourceKind: "manual",
        azureTestCaseId: "987",
        plan: {
          schemaVersion: "v2-natural",
          steps: [{ instruction: "Run it", expectedResult: "", layerHint: "auto" }],
        },
      },
    ]);
  });
});
