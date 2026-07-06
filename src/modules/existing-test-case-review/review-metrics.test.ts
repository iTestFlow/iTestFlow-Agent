import { describe, expect, it } from "vitest";

import { deriveExistingTestCaseReviewMetrics } from "./review-metrics";

// Matrix rows and findings reduced to the fields the derivation reads; the
// remaining validated-output fields play no part in these metrics.
function matrixRow(id: string, coverageStatus: string) {
  return { id, coverageStatus };
}

function finding(overrides: Partial<{ severity: string; category: string }> = {}) {
  return { severity: "Medium", category: "Missing coverage", ...overrides };
}

describe("deriveExistingTestCaseReviewMetrics", () => {
  it("buckets findings by exact High/Medium/Low severity only", () => {
    const metrics = deriveExistingTestCaseReviewMetrics({
      traceabilityMatrix: [],
      findings: [
        finding({ severity: "High" }),
        finding({ severity: "High" }),
        finding({ severity: "Medium" }),
        finding({ severity: "Low" }),
        // Casing variants and unknown labels land in no bucket.
        finding({ severity: "high" }),
        finding({ severity: "Critical" }),
      ],
    });

    expect(metrics.highRiskItemsFound).toBe(2);
    expect(metrics.mediumRiskItemsFound).toBe(1);
    expect(metrics.lowRiskItemsFound).toBe(1);
  });

  it("counts weak/duplicate cases as exactly Duplicate plus categories starting with Weak", () => {
    const metrics = deriveExistingTestCaseReviewMetrics({
      traceabilityMatrix: [],
      findings: [
        finding({ category: "Duplicate" }),
        finding({ category: "Weak steps" }),
        finding({ category: "Weak Assertion" }),
        // Excluded: other categories and case-sensitive misses.
        finding({ category: "Missing coverage" }),
        finding({ category: "duplicate" }),
        finding({ category: "weak steps" }),
        finding({ category: "Automation readiness" }),
      ],
    });

    expect(metrics.weakDuplicateCases).toBe(3);
  });

  it("treats every coverage status except the exact string Covered as a gap row", () => {
    const metrics = deriveExistingTestCaseReviewMetrics({
      traceabilityMatrix: [
        matrixRow("TM-1", "Covered"),
        matrixRow("TM-2", "Not covered"),
        matrixRow("TM-3", "Partially covered"),
        matrixRow("TM-4", "Needs review"),
        // Case-sensitive: these are not the covered status.
        matrixRow("TM-5", "covered"),
        matrixRow("TM-6", "Partially Covered"),
      ],
      findings: [],
    });

    expect(metrics.gapRows.map((row) => row.id)).toEqual(["TM-2", "TM-3", "TM-4", "TM-5", "TM-6"]);
  });

  it("returns all-zero metrics for an empty review", () => {
    expect(deriveExistingTestCaseReviewMetrics({ traceabilityMatrix: [], findings: [] })).toEqual({
      gapRows: [],
      weakDuplicateCases: 0,
      highRiskItemsFound: 0,
      mediumRiskItemsFound: 0,
      lowRiskItemsFound: 0,
    });
  });
});
