import { describe, expect, it, vi } from "vitest";
vi.mock("@/modules/audit/audit.service", () => ({ writeAuditLog: vi.fn() }));

import { fakeLlmProvider, projectScope, requirement } from "@/test/factories";
import { buildAcceptanceCriteriaContract } from "./acceptance-criteria-contract";
import { evaluateAcceptanceCriteriaCoverage } from "./acceptance-criteria-coverage";
import { GeneratedTestCaseSchema, TestCaseGenerationOutputSchema } from "./schemas/test-case.schema";
import { buildTestCaseGenerationPromptDraft, completeManualTestCaseGeneration, generateTestCases } from "./application/test-case-generation.service";
import { normalizeGenerationSummary, validateGenerationGrounding } from "./generation-grounding";
import { isSupportedTestCase, type TestCaseBasis } from "./test-case-basis";
import { buildTestCaseGenerationSystemPrompt } from "@/modules/llm/prompts/test-case-generation.prompt";
import { withStructuredOutputInstruction } from "@/modules/llm/prompts/structured-output.prompt";

const contract = buildAcceptanceCriteriaContract(requirement());
const manifest = ["WI:101", "AC-001", "KB:business_rule:keyboard", "SA:spec", "EXTRA:instructions"];
const requirementBasis: TestCaseBasis = { kind: "requirement", explanation: "The story documents order confirmation.", sourceReferences: ["AC-001"] };
const suggestedBasis: TestCaseBasis = { kind: "suggested", explanation: "Checkout has interactive controls; assume keyboard focus follows the visible reading order.", sourceReferences: ["WI:101"] };
const caseInput = {
  id: "TC-1", title: "Confirm checkout", description: "Confirm the order", priority: 2, type: "functional", category: "happy_path",
  preconditions: "Cart ready", relatedAcceptanceCriteria: ["AC-001"], basis: requirementBasis,
  steps: [{ stepNumber: 1, action: "Preconditions: cart ready", expectedResult: "Preconditions are met" }, { stepNumber: 2, action: "Pay", expectedResult: "Order confirmed" }],
};
const suggestion = { ...caseInput, id: "TC-2", title: "Keyboard focus order", type: "accessibility", basis: suggestedBasis, relatedAcceptanceCriteria: [] };
function output(testCases: unknown[] = [caseInput, suggestion]) {
  return TestCaseGenerationOutputSchema.parse({ testCases, summary: { totalCases: 99, byType: { invented: 99 }, byPriority: { "4": 99 }, coverageEstimate: 9 }, contextUsed: [] });
}

describe("Test Design basis contract", () => {
  it("requires basis only on the new generation contract and never auto-supports a legacy case", () => {
    const { basis: _basis, ...legacy } = caseInput;
    expect(GeneratedTestCaseSchema.safeParse(legacy).success).toBe(true);
    expect(() => output([legacy])).toThrow();
    expect(isSupportedTestCase(GeneratedTestCaseSchema.parse(legacy))).toBe(false);
    expect(() => output([{ ...caseInput, basis: { ...requirementBasis, explanation: "  " } }])).toThrow();
  });

  it.each(["requirement", "derived", "project_rule"] as const)("accepts %s only with a supplied source", (kind) => {
    const basis: TestCaseBasis = { kind, explanation: kind === "derived" ? "A documented minimum of 3 makes 2 below the minimum." : "Documented behavior.", sourceReferences: ["WI:101"] };
    expect(validateGenerationGrounding(contract, manifest, output([{ ...caseInput, basis }])).coveredCount).toBe(1);
    expect(() => validateGenerationGrounding(contract, manifest, output([{ ...caseInput, basis: { ...basis, sourceReferences: [] } }]))).toThrow(/must cite/);
  });

  it.each(["WI:excluded", "KB:business_rule:omitted", "SA:unseen", "EXTRA:absent", "accessibility"])("rejects unavailable source %s", (reference) => {
    expect(() => validateGenerationGrounding(contract, manifest, output([{ ...caseInput, basis: { ...requirementBasis, sourceReferences: [reference] } }]))).toThrow(/not supplied/);
  });

  it("supports an explicit supplied accessibility rule, an attachment, and explicit instructions", () => {
    for (const source of ["KB:business_rule:keyboard", "SA:spec", "EXTRA:instructions"]) {
      expect(validateGenerationGrounding(contract, manifest, output([{ ...caseInput, type: "accessibility", basis: { kind: "project_rule", explanation: "The supplied rule requires keyboard focus order.", sourceReferences: [source] } }])).coveredCount).toBe(1);
    }
  });

  it("rejects suggestion AC claims, including claims in basis sources", () => {
    for (const candidate of [{ ...suggestion, relatedAcceptanceCriteria: ["AC-001"] }, { ...suggestion, basis: { ...suggestedBasis, sourceReferences: ["AC-001"] } }]) {
      expect(() => validateGenerationGrounding(contract, manifest, output([caseInput, candidate]))).toThrow(/cannot claim acceptance criteria/);
    }
    expect(() => validateGenerationGrounding(contract, manifest, output([suggestion]))).toThrow(/0 of 1/);
  });

  it("recomputes counts and AC percentage, including a supported-only result", () => {
    const mixed = output();
    expect(normalizeGenerationSummary(mixed, validateGenerationGrounding(contract, manifest, mixed)).summary).toEqual({
      totalCases: 2, supportedCases: 1, suggestedCases: 1, byType: { functional: 1, accessibility: 1 }, byPriority: { "2": 2 }, coverageEstimate: 100,
    });
    const supported = output([caseInput]);
    expect(normalizeGenerationSummary(supported, validateGenerationGrounding(contract, manifest, supported)).summary).toMatchObject({ supportedCases: 1, suggestedCases: 0 });
  });

  it("excludes even selected suggestions and retains original positions for AC links", () => {
    const cases = [suggestion, { ...caseInput, id: "supported" }, { ...suggestion, id: "bad-legacy-suggestion", relatedAcceptanceCriteria: ["AC-001"] }];
    expect(evaluateAcceptanceCriteriaCoverage(contract, { testCases: cases }).casePositionsByCriterion["AC-001"]).toEqual([2]);
    expect(evaluateAcceptanceCriteriaCoverage(contract, { testCases: cases }, ["supported", "TC-2"]).casePositionsByCriterion["AC-001"]).toEqual([2]);
    expect(evaluateAcceptanceCriteriaCoverage(contract, { testCases: cases }, ["bad-legacy-suggestion"]).coveredCount).toBe(0);
  });

  it("uses the same validation and normalized summaries in automatic and manual modes", async () => {
    const mixed = output();
    const automatic = await generateTestCases({ scope: projectScope(), actor: "qa", provider: fakeLlmProvider({ structuredOutput: mixed }), targetRequirement: requirement(), selectedContext: [] });
    const manual = completeManualTestCaseGeneration({ scope: projectScope(), actor: "qa", rawOutput: JSON.stringify(mixed), acceptanceCriteriaContract: contract, sourceManifest: manifest });
    expect(automatic.validatedOutput).toEqual(manual.validatedOutput);
    expect(manual.validatedOutput.testCases[1].basis.kind).toBe("suggested");
    expect(manual.validatedOutput.summary.suggestedCases).toBe(1);
    expect(() => completeManualTestCaseGeneration({ scope: projectScope(), actor: "qa", rawOutput: JSON.stringify(mixed), acceptanceCriteriaContract: contract, sourceManifest: ["AC-001"] })).toThrow(/not supplied/);
  });

  it("repairs a bad source once using the rejected output and exact errors", async () => {
    const bad = output([{ ...caseInput, basis: { ...requirementBasis, sourceReferences: ["WI:omitted"] } }]);
    const good = output([caseInput]);
    const provider = fakeLlmProvider();
    let attempt = 0;
    provider.generateStructuredOutput = vi.fn(async (request) => {
      const validatedOutput = attempt++ ? good : bad;
      const rawOutput = JSON.stringify(validatedOutput);
      request.validateOutput?.({ validatedOutput, rawOutput });
      return { provider: "openai" as const, model: "test", rawOutput, validatedOutput };
    }) as typeof provider.generateStructuredOutput;
    const result = await generateTestCases({ scope: projectScope(), actor: "qa", provider, targetRequirement: requirement(), selectedContext: [] });
    expect(result.correctionAttempts).toBe(1);
    expect(provider.generateStructuredOutput).toHaveBeenCalledTimes(2);
    const repair = vi.mocked(provider.generateStructuredOutput).mock.calls[1][0];
    expect(repair.user).toContain("WI:omitted was not supplied");
    expect(repair.redactRequestLog).toBe(true);
  });

  it("keeps default focus, makes optional assumptions explicit, and includes basis in repair shapes only for Test Design", () => {
    const prompt = buildTestCaseGenerationSystemPrompt();
    expect(prompt).toContain("### Accessibility");
    expect(prompt).toContain("A selected focus, platform convention, or best practice is never requirement evidence.");
    expect(prompt).toContain("a documented minimum of 3 implies that 2 is below the minimum");
    expect(prompt).toContain("Suggestions have no separate cap");
    expect(prompt).not.toContain("Generate only supported test cases");
    expect(withStructuredOutputInstruction("", "TestCaseGenerationOutput")).toContain('"basis"');
    expect(withStructuredOutputInstruction("", "ExistingTestCaseReviewOutput")).not.toContain('"basis"');
    const draft = buildTestCaseGenerationPromptDraft({ scope: projectScope(), targetRequirement: requirement(), selectedContext: [], extraInstructions: "Keyboard focus follows reading order." });
    expect(draft.sourceManifest).toEqual(["AC-001", "EXTRA:instructions", "WI:101"]);
    expect(draft.userPrompt).toContain("Output contract version: 2");
  });
});
