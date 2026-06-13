/**
 * Shared normalization for test "coverage category" labels recorded in workflow-run
 * metadata (metadata.testDesign.categories). Both the automated generate routes and the
 * manual/review routes feed the same Coverage Category Distribution chart, so they must
 * group categories identically — otherwise "happy path" and "Positive" become two bars
 * for the same concept.
 */
export function normalizeCoverageCategory(value: string) {
  const normalized = value.trim().toLowerCase().replace(/[_-]+/g, " ");
  const labels: Record<string, string> = {
    "happy path": "Positive",
    positive: "Positive",
    negative: "Negative",
    edge: "Boundary",
    boundary: "Boundary",
    integration: "Integration",
    e2e: "E2E",
    ui: "UI/UX",
    accessibility: "Accessibility",
    security: "Security/Privacy",
    performance: "Performance/Concurrency",
  };
  return labels[normalized] ?? value;
}

export function countTestCategories(testCases: Array<{ type: string; category: string }>) {
  return testCases.reduce<Record<string, number>>((counts, testCase) => {
    const category = normalizeCoverageCategory(testCase.category || testCase.type);
    counts[category] = (counts[category] ?? 0) + 1;
    return counts;
  }, {});
}
