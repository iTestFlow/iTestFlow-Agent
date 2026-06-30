import { describe, expect, it, vi } from "vitest";

vi.mock("@/modules/audit/audit.service", () => ({
  writeAuditLog: vi.fn(),
}));

import { fakeLlmProvider, projectScope, requirement } from "@/test/factories";
import {
  allCoverageFocusIds,
  isTargetTestCaseRangeId,
  normalizeTestDesignOptions,
} from "./test-design-options";
import {
  CANONICAL_FIRST_STEP_EXPECTED,
  GeneratedTestCaseSchema,
  TestCaseGenerationOutputSchema,
  TestCasePrioritySchema,
  TestCaseTypeSchema,
} from "./schemas/test-case.schema";
import {
  completeManualTestCaseGeneration,
  generateTestCases,
} from "./application/test-case-generation.service";

const validCase = {
  id: "TC-1",
  title: "Checkout succeeds",
  description: "Valid card completes checkout.",
  priority: "2",
  type: "Integration / API",
  category: "Positive",
  preconditions: "Cart has an item",
  steps: [
    { stepNumber: 1, action: "Preconditions: cart is ready", expectedResult: "Anything" },
    { stepNumber: 2, action: "Pay", expectedResult: "Order is created" },
  ],
};

describe("test design options and schema", () => {
  it("normalizes invalid options to ordered defaults", () => {
    expect(normalizeTestDesignOptions({ targetTestCaseRange: "bad" as never })).toMatchObject({
      targetTestCaseRange: "extended_regression",
      minCases: 15,
      maxCases: 30,
      coverageFocusIds: allCoverageFocusIds,
    });
  });

  it("clamps custom ranges and removes unknown or duplicate focus values", () => {
    expect(normalizeTestDesignOptions({
      targetTestCaseRange: "custom",
      customMinCases: -10,
      customMaxCases: 100,
      coverageFocusIds: ["accessibility", "functional", "accessibility"],
    })).toMatchObject({
      minCases: 1,
      maxCases: 50,
      coverageFocusIds: ["functional", "accessibility"],
    });
  });

  it("recognizes only supported ranges", () => {
    expect(isTargetTestCaseRangeId("quick_confidence")).toBe(true);
    expect(isTargetTestCaseRangeId("quick")).toBe(false);
  });

  it("normalizes model aliases, priorities, defaults, and the precondition result", () => {
    const parsed = GeneratedTestCaseSchema.parse(validCase);
    expect(parsed.priority).toBe(2);
    expect(parsed.type).toBe("integration");
    expect(parsed.tags).toEqual([]);
    expect(parsed.steps[0]?.expectedResult).toBe(CANONICAL_FIRST_STEP_EXPECTED);
  });

  it("rejects a non-precondition first step and unsupported values", () => {
    expect(GeneratedTestCaseSchema.safeParse({
      ...validCase,
      steps: [{ stepNumber: 1, action: "Open app", expectedResult: "App opens" }],
    }).success).toBe(false);
    expect(TestCasePrioritySchema.safeParse(5).success).toBe(false);
    expect(TestCaseTypeSchema.safeParse("made-up").success).toBe(false);
  });

  it("supports automatic and external-LLM generation through the same schema", async () => {
    const generated = {
      testCases: [GeneratedTestCaseSchema.parse(validCase)],
      summary: {
        totalCases: 1,
        byType: { integration: 1 },
        byPriority: { "2": 1 },
        coverageEstimate: 80,
      },
      contextUsed: ["WI:101"],
    };
    const provider = fakeLlmProvider({ structuredOutput: generated });
    await expect(generateTestCases({
      scope: projectScope(),
      actor: "qa",
      provider,
      targetRequirement: requirement(),
      selectedContext: [],
      options: { targetTestCaseRange: "quick_confidence" },
    })).resolves.toMatchObject({ validatedOutput: generated });
    expect(provider.generateStructuredOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaName: "TestCaseGenerationOutput",
        metadata: expect.objectContaining({ targetWorkItemId: "101" }),
      }),
    );

    expect(completeManualTestCaseGeneration({
      scope: projectScope(),
      actor: "qa",
      rawOutput: JSON.stringify(generated),
      targetWorkItemId: "101",
    })).toMatchObject({
      provider: "external",
      validatedOutput: generated,
    });
  });

  describe("TestCaseGenerationOutputSchema direct validation", () => {
    const validOutput = {
      testCases: [validCase],
      summary: {
        totalCases: 1,
        byType: { integration: 1 },
        byPriority: { "2": 1 },
        coverageEstimate: 80,
      },
      contextUsed: ["WI:101"],
    };

    it("parses a full valid generation output", () => {
      const result = TestCaseGenerationOutputSchema.safeParse(validOutput);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.testCases).toHaveLength(1);
        expect(result.data.testCases[0]?.priority).toBe(2);
        expect(result.data.testCases[0]?.type).toBe("integration");
        expect(result.data.testCases[0]?.steps[0]?.expectedResult).toBe(CANONICAL_FIRST_STEP_EXPECTED);
      }
    });

    it("rejects a generation output with an invalid priority", () => {
      const result = TestCaseGenerationOutputSchema.safeParse({
        ...validOutput,
        testCases: [{ ...validCase, priority: 7 }],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path.includes("priority"))).toBe(true);
      }
    });

    it("rejects a generation output with an unsupported test case type", () => {
      const result = TestCaseGenerationOutputSchema.safeParse({
        ...validOutput,
        testCases: [{ ...validCase, type: "made-up" }],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path.includes("type"))).toBe(true);
      }
    });
  });
});
