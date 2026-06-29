import { describe, expect, it } from "vitest";

import type {
  RequirementFinding,
  RequirementSummary,
} from "@/components/workflow/test-intelligence-types";

import { buildRequirementAnalysisComment } from "./requirement-analysis-comment";

const summary: RequirementSummary = {
  totalFindings: 99,
  criticalCount: 99,
  highCount: 99,
  mediumCount: 99,
  lowCount: 99,
  infoCount: 99,
  overallQuality: "fair",
  completenessScore: 60,
  clarityScore: 65,
  testabilityScore: 50,
  summaryText: "The requirement needs targeted clarification before delivery.",
};

function finding(
  id: string,
  severity: RequirementFinding["severity"],
): RequirementFinding {
  return {
    id,
    checklistItemId: "ambiguity_clarity",
    issueType: "ambiguity",
    severity,
    title: `${severity} finding`,
    description: `Description for ${severity}.`,
    suggestion: `Resolve the ${severity} finding.`,
    riskLevel: severity === "critical" || severity === "high" ? "high" : "medium",
    riskJustification: `${severity} risk justification.`,
    affectedAreas: ["Acceptance criteria"],
    references: [],
    contradiction: false,
  };
}

describe("buildRequirementAnalysisComment", () => {
  it("renders compact selected-finding counts without score or delivery summary sections", () => {
    const comment = buildRequirementAnalysisComment({
      workItemId: "123",
      summary,
      findings: [
        finding("F-001", "critical"),
        finding("F-002", "high"),
        finding("F-003", "medium"),
        finding("F-004", "medium"),
        finding("F-005", "low"),
        finding("F-006", "info"),
      ],
    });

    expect(comment).toContain("# 🧪 iTestFlow Requirement Analysis for 123");
    expect(comment).toContain("## 🚦 Requirement Readiness Decision");
    expect(comment).toContain("**Status:** ⛔ Needs Refinement Before Implementation / Test Design");
    expect(comment).toContain("## 📊 Executive Summary");
    expect(comment).toContain("| Total | 🔴 Critical | 🟠 High | 🟡 Medium | 🟢 Low | 🔵 Info |");
    expect(comment).toContain("| 6 | 1 | 1 | 2 | 1 | 1 |");
    expect(comment).toContain(summary.summaryText);

    expect(comment).not.toContain("| Quality |");
    expect(comment).not.toContain("| Clarity |");
    expect(comment).not.toContain("| Completeness |");
    expect(comment).not.toContain("| Testability |");
    expect(comment).not.toContain("65%");
    expect(comment).not.toContain("60%");
    expect(comment).not.toContain("50%");
    expect(comment).not.toContain("## Delivery Impact Summary");

    expect(comment).toContain("## 🎯 Top Required Actions");
    expect(comment).toContain("| 🔴 P1 · Critical |");
    expect(comment).toContain("| 🟠 P1 · High |");
    expect(comment).toContain("| 🟡 P2 · Medium |");
    expect(comment).toContain("## 🔎 Detailed Findings");
    expect(comment).toContain("### 1. 🔴 Critical — critical finding");
    expect(comment).toContain("### 2. 🟠 High — high finding");
    expect(comment).toContain("### 3. 🟡 Medium — medium finding");
    expect(comment).toContain("### 5. 🟢 Low — low finding");
    expect(comment).toContain("### 6. 🔵 Info — info finding");
    expect(comment).toContain("**Delivery Impact:** Blocking / Must Clarify");
  });

  it("renders zero counts and omits finding-only sections when no findings are selected", () => {
    const comment = buildRequirementAnalysisComment({
      workItemId: "456",
      summary: { ...summary, summaryText: "" },
      findings: [],
    });

    expect(comment).toContain("| Total | 🔴 Critical | 🟠 High | 🟡 Medium | 🟢 Low | 🔵 Info |");
    expect(comment).toContain("| 0 | 0 | 0 | 0 | 0 | 0 |");
    expect(comment).toContain("## 🚦 Requirement Readiness Decision");
    expect(comment).toContain("**Status:** ✅ Ready for Implementation / Test Design");
    expect(comment).toContain("## 📊 Executive Summary");
    expect(comment).not.toContain("## Delivery Impact Summary");
    expect(comment).not.toContain("## 🎯 Top Required Actions");
    expect(comment).not.toContain("## 🔎 Detailed Findings");
  });

  it.each([
    ["medium", "⚠️ Review Recommended Before UAT"],
    ["low", "✅ Mostly Ready With Minor Improvements"],
  ] as const)("renders the expected readiness icon for %s findings", (severity, expectedStatus) => {
    const comment = buildRequirementAnalysisComment({
      workItemId: "789",
      summary,
      findings: [finding("F-001", severity)],
    });

    expect(comment).toContain(`**Status:** ${expectedStatus}`);
  });
});
