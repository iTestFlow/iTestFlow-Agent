/**
 * Workflow-run metric derivation shared by the automated run route and the
 * manual submit route. Both record analytics for the same validated review
 * output, so the severity buckets, weak/duplicate count, and gap rows must be
 * computed identically or the dashboards diverge by entry path.
 */
export function deriveExistingTestCaseReviewMetrics<Row extends { coverageStatus: string }>(validatedOutput: {
  traceabilityMatrix: Row[];
  findings: Array<{ severity: string; category: string }>;
}) {
  const { traceabilityMatrix, findings } = validatedOutput;
  return {
    // Only the exact status "Covered" counts as covered; every other value
    // ("Partially covered", "Not covered", "Needs review") is a gap.
    gapRows: traceabilityMatrix.filter((row) => row.coverageStatus !== "Covered"),
    weakDuplicateCases: findings.filter(
      (finding) => finding.category === "Duplicate" || finding.category.startsWith("Weak"),
    ).length,
    highRiskItemsFound: findings.filter((finding) => finding.severity === "High").length,
    mediumRiskItemsFound: findings.filter((finding) => finding.severity === "Medium").length,
    lowRiskItemsFound: findings.filter((finding) => finding.severity === "Low").length,
  };
}
