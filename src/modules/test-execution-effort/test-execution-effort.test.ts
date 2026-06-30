import { describe, expect, it } from "vitest";

import { projectScope, requirement, testCase } from "@/test/factories";
import {
  buildTestExecutionEffortPreview,
  buildTestExecutionEffortPromptDraft,
  NO_LINKED_TEST_CASES_MESSAGE,
  normalizeTestExecutionEffortOptions,
  toSafeTestExecutionEffortError,
} from "./test-execution-effort.service";
import { StoryIdSchema, TestExecutionEffortOutputSchema } from "./test-execution-effort.schema";

describe("test execution effort", () => {
  it("normalizes an empty option object to defaults", () => {
    expect(normalizeTestExecutionEffortOptions({})).toEqual({
      testerSeniority: "mid",
      executionType: "first_execution",
      includeDataPreparation: true,
      includeEnvironmentSetup: true,
      includeEvidenceAndDefectLogging: true,
      includeRetestingBuffer: true,
    });
  });

  it("validates numeric story IDs", () => {
    expect(StoryIdSchema.parse(" 123 ")).toBe("123");
    expect(StoryIdSchema.safeParse("AB-1").success).toBe(false);
  });

  it("builds a useful preview and warns for non-requirement work items", () => {
    const cases = [testCase(), testCase({ id: "202", steps: [] })];
    const preview = buildTestExecutionEffortPreview({
      targetRequirement: requirement({ workItemType: "Task" }),
      linkedTestCases: cases,
      hasProjectContext: true,
    });
    expect(preview.summary).toMatchObject({
      linkedTestCaseCount: 2,
      totalSteps: 2,
      testCasesWithMissingSteps: 1,
      hasProjectContext: true,
    });
    expect(preview.summary.workItemTypeWarning).toContain("Task");
  });

  it("refuses prompt generation without linked test cases", () => {
    expect(() => buildTestExecutionEffortPromptDraft({
      scope: projectScope(),
      targetRequirement: requirement(),
      linkedTestCases: [],
      selectedContext: [],
      options: normalizeTestExecutionEffortOptions({}),
    })).toThrow(NO_LINKED_TEST_CASES_MESSAGE);
  });

  it("maps external failure classes to safe responses", () => {
    expect(toSafeTestExecutionEffortError(new Error(NO_LINKED_TEST_CASES_MESSAGE), "fallback").status).toBe(400);
    expect(toSafeTestExecutionEffortError(new Error("429 quota"), "fallback").message).toContain("rate-limited");
    expect(toSafeTestExecutionEffortError(new Error("secret upstream detail"), "fallback")).toEqual({
      status: 503,
      message: "fallback",
    });
  });

  const validEffortOutput = () => ({
    story: { id: "1", title: "Story", workItemType: "User Story", state: "Active" },
    executionProfile: {
      testerSeniority: "mid",
      executionType: "first_execution",
      includedFactors: {
        dataPreparation: true,
        environmentSetup: true,
        evidenceAndDefectLogging: true,
        retestingBuffer: true,
      },
    },
    statistics: {
      testCaseCount: 0, totalSteps: 0, averageStepsPerTestCase: 0,
      simpleTestCases: 0, mediumTestCases: 0, complexTestCases: 0,
      testCasesWithMissingSteps: 0, integrationPointsCount: 0,
      dataPreparationComplexity: "Low", environmentSetupComplexity: "Low",
      executionComplexity: "Low",
    },
    estimate: {
      minimumHours: 1, mostLikelyHours: 2, maximumHours: 3,
      recommendedPlanningHours: 2, confidence: "Low", confidenceReason: "Incomplete",
    },
    breakdown: [], testCaseEstimates: [], assumptions: [],
    risksThatMayIncreaseTime: [], recommendations: [],
  });

  it("rejects mostLikelyHours below minimumHours and pins the issue path", () => {
    const output = validEffortOutput();
    // minimum 1, mostLikely 0 -> violates only mostLikely>=minimum.
    // maximum (3) and recommended (2) remain >= mostLikely (0), so their checks stay satisfied.
    output.estimate.mostLikelyHours = 0;
    const result = TestExecutionEffortOutputSchema.safeParse(output);
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((issue) => issue.path.join("."));
    expect(paths).toContain("estimate.mostLikelyHours");
    expect(paths).not.toContain("estimate.maximumHours");
    expect(paths).not.toContain("estimate.recommendedPlanningHours");
  });

  it("rejects maximumHours below mostLikelyHours and pins the issue path", () => {
    const output = validEffortOutput();
    output.estimate.maximumHours = 1; // below mostLikelyHours (2); minimum (1) <= mostLikely, recommended (2) >= mostLikely
    const result = TestExecutionEffortOutputSchema.safeParse(output);
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((issue) => issue.path.join("."));
    expect(paths).toContain("estimate.maximumHours");
    expect(paths).not.toContain("estimate.mostLikelyHours");
    expect(paths).not.toContain("estimate.recommendedPlanningHours");
  });

  it("rejects recommendedPlanningHours below mostLikelyHours and pins the issue path", () => {
    const output = validEffortOutput();
    output.estimate.recommendedPlanningHours = 1; // below mostLikelyHours (2); minimum/maximum stay monotonic
    const result = TestExecutionEffortOutputSchema.safeParse(output);
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((issue) => issue.path.join("."));
    expect(paths).toContain("estimate.recommendedPlanningHours");
    expect(paths).not.toContain("estimate.mostLikelyHours");
    expect(paths).not.toContain("estimate.maximumHours");
  });

  it("enforces monotonic estimate ranges", () => {
    const output = {
      story: { id: "1", title: "Story", workItemType: "User Story", state: "Active" },
      executionProfile: {
        testerSeniority: "mid",
        executionType: "first_execution",
        includedFactors: {
          dataPreparation: true,
          environmentSetup: true,
          evidenceAndDefectLogging: true,
          retestingBuffer: true,
        },
      },
      statistics: {
        testCaseCount: 0, totalSteps: 0, averageStepsPerTestCase: 0,
        simpleTestCases: 0, mediumTestCases: 0, complexTestCases: 0,
        testCasesWithMissingSteps: 0, integrationPointsCount: 0,
        dataPreparationComplexity: "Low", environmentSetupComplexity: "Low",
        executionComplexity: "Low",
      },
      estimate: {
        minimumHours: 3, mostLikelyHours: 2, maximumHours: 1,
        recommendedPlanningHours: 1, confidence: "Low", confidenceReason: "Incomplete",
      },
      breakdown: [], testCaseEstimates: [], assumptions: [],
      risksThatMayIncreaseTime: [], recommendations: [],
    };
    expect(TestExecutionEffortOutputSchema.safeParse(output).success).toBe(false);
    const valid = {
      ...output,
      estimate: {
        ...output.estimate,
        minimumHours: 1,
        mostLikelyHours: 2,
        maximumHours: 3,
        recommendedPlanningHours: 2,
      },
    };
    expect(TestExecutionEffortOutputSchema.safeParse(valid).success).toBe(true);
  });
});
