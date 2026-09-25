import type { AcceptanceCriteriaContract } from "./acceptance-criteria-contract";

export type AcceptanceCriteriaCoverage = {
  requiredCount: number;
  coveredCount: number;
  missingCriteria: Array<{ id: string; text: string }>;
  unknownReferences: Array<{ id: string; casePosition: number }>;
  casePositionsByCriterion: Record<string, number[]>;
};

export function evaluateAcceptanceCriteriaCoverage(
  contract: AcceptanceCriteriaContract,
  output: { testCases: Array<{ relatedAcceptanceCriteria?: string[] }> },
): AcceptanceCriteriaCoverage {
  const known = new Set(contract.criteria.map((criterion) => criterion.id));
  const mapped = new Map(contract.criteria.map((criterion) => [criterion.id, new Set<number>()]));
  const unknownReferences: AcceptanceCriteriaCoverage["unknownReferences"] = [];
  output.testCases.forEach((testCase, index) => {
    for (const id of new Set(testCase.relatedAcceptanceCriteria ?? [])) {
      if (known.has(id)) mapped.get(id)?.add(index + 1);
      else unknownReferences.push({ id, casePosition: index + 1 });
    }
  });
  const missingCriteria = contract.criteria.filter((criterion) => !mapped.get(criterion.id)?.size);
  return {
    requiredCount: contract.criteria.length,
    coveredCount: contract.criteria.length - missingCriteria.length,
    missingCriteria,
    unknownReferences,
    casePositionsByCriterion: Object.fromEntries([...mapped].map(([id, positions]) => [id, [...positions]])),
  };
}
