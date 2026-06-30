import { describe, expect, it, vi } from "vitest";

vi.mock("@/modules/audit/audit.service", () => ({
  writeAuditLog: vi.fn(),
}));

import { fakeLlmProvider, projectScope, requirement, testCase } from "@/test/factories";
import {
  buildExistingTestCaseReviewPromptDraft,
  completeManualExistingTestCaseReview,
  reviewExistingLinkedTestCases,
} from "./application/existing-test-case-review.service";
import {
  ExistingTestCaseReviewOutputSchema,
  ExistingTestCaseSourceTypeSchema,
  ExistingTestCaseTraceabilityMatrixRowSchema,
} from "./schemas/existing-test-case-review.schema";

describe("existing test-case review", () => {
  it.each([
    ["acceptance criteria", "acceptanceCriteria"],
    ["business_rules", "businessRules"],
    ["story", "story"],
  ])("normalizes source type %s", (input, expected) => {
    expect(ExistingTestCaseSourceTypeSchema.parse(input)).toBe(expected);
  });

  it("truncates oversized source evidence and supplies defaults", () => {
    const row = ExistingTestCaseTraceabilityMatrixRowSchema.parse({
      id: "TM-1",
      sourceType: "description",
      sourceReference: "Description",
      sourceText: "x".repeat(600),
      requirementText: "Requirement",
      coverageStatus: "Needs review",
      severity: "Medium",
      recommendedMinimumTestCount: 1,
      recommendedAction: "Review",
    });
    expect(row.sourceText).toHaveLength(503);
    expect(row.linkedTestCaseIds).toEqual([]);
  });

  it("rejects scores outside 0-100", () => {
    expect(ExistingTestCaseReviewOutputSchema.safeParse({
      summary: "summary",
      coverageScore: 101,
      traceabilityMatrix: [],
      findings: [],
      suggestedAdditions: [],
    }).success).toBe(false);
  });

  it("builds a prompt from the requirement and linked cases", () => {
    const draft = buildExistingTestCaseReviewPromptDraft({
      scope: projectScope(),
      targetRequirement: requirement(),
      linkedTestCases: [testCase()],
      selectedContext: [],
    });
    expect(draft.schemaName).toBe("ExistingTestCaseReviewOutput");
    expect(draft.userPrompt).toContain("Customer checks out");
    expect(draft.userPrompt).toContain("Successful checkout");
  });

  it("supports automatic and external review with one validated output shape", async () => {
    const output = {
      summary: "One linked case covers checkout.",
      coverageScore: 90,
      traceabilityMatrix: [],
      insights: [],
      findings: [],
      suggestedAdditions: [],
      contextUsed: ["WI:101"],
    };
    const provider = fakeLlmProvider({ structuredOutput: output });
    await expect(reviewExistingLinkedTestCases({
      scope: projectScope(),
      actor: "qa",
      provider,
      targetRequirement: requirement(),
      linkedTestCases: [testCase()],
      selectedContext: [],
    })).resolves.toMatchObject({ validatedOutput: output });

    expect(completeManualExistingTestCaseReview({
      scope: projectScope(),
      actor: "qa",
      rawOutput: JSON.stringify(output),
      targetWorkItemId: "101",
    })).toMatchObject({ provider: "external", validatedOutput: output });
  });

  describe("ExistingTestCaseReviewOutputSchema direct validation", () => {
    const suggestedAddition = {
      id: "TC-9",
      title: "Verify declined payment is rejected",
      description: "A declined card must not complete checkout.",
      priority: "2",
      type: "functional",
      category: "Negative",
      preconditions: "Cart has an item and a declined card on file",
      steps: [
        { stepNumber: 1, action: "Preconditions: cart and declined card ready", expectedResult: "Anything" },
        { stepNumber: 2, action: "Submit declined payment", expectedResult: "Checkout is rejected" },
      ],
    };

    const fullOutput = {
      summary: "Checkout coverage is mostly complete with one gap.",
      coverageScore: 78,
      traceabilityMatrix: [{
        id: "TM-1",
        sourceType: "acceptanceCriteria",
        sourceReference: "AC-1",
        sourceText: "Given a cart, when checkout succeeds, then show confirmation.",
        requirementText: "Successful checkout shows confirmation.",
        coverageStatus: "Partially covered",
        severity: "Medium",
        linkedTestCaseIds: ["201"],
        evidenceSummary: "One linked case covers the happy path.",
        missingCoverage: "Declined payment is not covered.",
        recommendedMinimumTestCount: 2,
        recommendedAction: "Add a declined-payment case.",
      }],
      insights: [{
        id: "INS-1",
        severity: "Low",
        title: "Happy path is well covered",
        explanation: "The successful checkout flow is exercised end to end.",
        relatedMatrixRowIds: ["TM-1"],
        relatedTestCaseIds: ["201"],
        suggestedAction: "Maintain the existing case.",
      }],
      findings: [{
        id: "F-1",
        category: "Missing coverage",
        severity: "High",
        title: "No declined-payment coverage",
        explanation: "There is no test for a declined card at checkout.",
        relatedMatrixRowIds: ["TM-1"],
        relatedTestCaseIds: [],
        suggestedAction: "Add a declined-payment negative case.",
      }],
      suggestedAdditions: [suggestedAddition],
      contextUsed: ["WI:101"],
    };

    it("parses a realistic full review output", () => {
      const result = ExistingTestCaseReviewOutputSchema.safeParse(fullOutput);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.traceabilityMatrix).toHaveLength(1);
        expect(result.data.findings[0]?.category).toBe("Missing coverage");
        expect(result.data.suggestedAdditions[0]?.priority).toBe(2);
      }
    });

    it("rejects a finding with an unsupported category enum", () => {
      const result = ExistingTestCaseReviewOutputSchema.safeParse({
        ...fullOutput,
        findings: [{ ...fullOutput.findings[0], category: "Not a real category" }],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path.includes("category"))).toBe(true);
      }
    });
  });
});
