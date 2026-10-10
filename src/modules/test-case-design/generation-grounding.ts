import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import { AppErrorCode } from "@/modules/shared/errors/app-error";
import { AcceptanceCriteriaError, type AcceptanceCriteriaContract } from "./acceptance-criteria-contract";
import { evaluateAcceptanceCriteriaCoverage } from "./acceptance-criteria-coverage";
import type { TestCaseGenerationOutput } from "./schemas/test-case.schema";
import { normalizeSuggestedTestCaseTitle } from "./test-case-basis";

export const SourceManifestSchema = z.array(z.string().trim().min(1).max(1000)).max(10000);

export function canonicalSourceManifest(ids: readonly string[]) {
  return [...new Set(ids)].sort();
}

export function sourceManifestHash(ids: readonly string[]) {
  return createHash("sha256").update(JSON.stringify(canonicalSourceManifest(ids))).digest("hex");
}

/** Checks structure and supplied source identities, not whether the model's claims are true. */
export function validateGenerationGrounding(
  contract: AcceptanceCriteriaContract,
  sourceManifest: readonly string[],
  output: TestCaseGenerationOutput,
) {
  const supplied = new Set(sourceManifest);
  const basisErrors: Array<{ casePosition: number; message: string }> = [];
  output.testCases.forEach((testCase, index) => {
    const fail = (message: string) => basisErrors.push({ casePosition: index + 1, message });
    if (!testCase.basis) { fail("Add a basis with kind, explanation, and sourceReferences."); return; }
    if (testCase.basis.kind !== "suggested" && !testCase.basis.sourceReferences.length) {
      fail("Supported cases must cite at least one supplied source ID.");
    }
    for (const reference of new Set(testCase.basis.sourceReferences)) {
      if (!supplied.has(reference)) fail(`Source ${reference} was not supplied in this prompt. Remove it or choose a supplied source.`);
    }
    if (testCase.basis.kind === "suggested" && (testCase.relatedAcceptanceCriteria.length || testCase.basis.sourceReferences.some((id) => /^AC-/.test(id)))) {
      fail("Suggested coverage cannot claim acceptance criteria. Remove its AC references; map required AC IDs using supported cases.");
    }
  });
  const coverage = evaluateAcceptanceCriteriaCoverage(contract, output);
  if (basisErrors.length || coverage.missingCriteria.length || coverage.unknownReferences.length) {
    throw new AcceptanceCriteriaError(
      AppErrorCode.AcceptanceCriteriaCoverage,
      `Test case basis or AC mapping needs correction: ${coverage.coveredCount} of ${coverage.requiredCount} AC IDs mapped. ${basisErrors[0]?.message ?? "Add missing IDs and remove unknown references."}`,
      { coverage, basisErrors },
    );
  }
  return coverage;
}

export function normalizeGenerationSummary(output: TestCaseGenerationOutput, coverage: ReturnType<typeof evaluateAcceptanceCriteriaCoverage>): TestCaseGenerationOutput {
  const byType: Record<string, number> = {};
  const byPriority: Record<string, number> = {};
  let suggestedCases = 0;
  for (const testCase of output.testCases) {
    byType[testCase.type] = (byType[testCase.type] ?? 0) + 1;
    byPriority[testCase.priority] = (byPriority[testCase.priority] ?? 0) + 1;
    if (testCase.basis.kind === "suggested") suggestedCases += 1;
  }
  return { ...output, testCases: output.testCases.map(normalizeSuggestedTestCaseTitle), summary: {
    totalCases: output.testCases.length,
    supportedCases: output.testCases.length - suggestedCases,
    suggestedCases,
    byType,
    byPriority,
    coverageEstimate: coverage.requiredCount ? Math.round(100 * coverage.coveredCount / coverage.requiredCount) : 0,
  } };
}
