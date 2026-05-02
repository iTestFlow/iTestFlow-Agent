import "server-only";

export type CoverageStatus = "Covered" | "Partially covered" | "Not covered" | "Not applicable" | "Needs review";

export type CoverageMatrixInput = {
  sources: Array<{
    id: string;
    type: "Acceptance Criteria" | "Business Rule" | "Risk" | "Dependency";
    text: string;
  }>;
  testCases: Array<{
    id: string;
    title: string;
    steps: Array<{ action: string; expectedResult?: string }>;
    selected: boolean;
  }>;
};

export function buildCoverageMatrix(input: CoverageMatrixInput) {
  const selectedCases = input.testCases.filter((testCase) => testCase.selected);
  return input.sources.map((source) => {
    const terms = source.text.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 3);
    const mapped = selectedCases.filter((testCase) => {
      const haystack = `${testCase.title} ${testCase.steps.map((step) => `${step.action} ${step.expectedResult ?? ""}`).join(" ")}`.toLowerCase();
      return terms.some((term) => haystack.includes(term));
    });

    return {
      sourceId: source.id,
      sourceType: source.type,
      sourceText: source.text,
      mappedTestCaseIds: mapped.map((testCase) => testCase.id),
      status: deriveCoverageStatus(mapped.length, selectedCases.length),
      confidenceScore: mapped.length ? Math.min(95, 60 + mapped.length * 10) : 30,
    };
  });
}

function deriveCoverageStatus(mappedCount: number, totalCount: number): CoverageStatus {
  if (!mappedCount) return "Not covered";
  if (mappedCount >= Math.max(1, Math.ceil(totalCount * 0.4))) return "Covered";
  return "Partially covered";
}
