import type { GeneratedTestCase } from "@/components/workflow/test-intelligence-types";

/**
 * Pure builders that turn a generated bug report into the suggested regression
 * test case offered on the Report Bug page. Extracted verbatim from
 * `report-bug-client.tsx`; the output is sent as `suggestedTestCase` to
 * `/api/bugs/reproduction-test-case/publish`, so it must keep satisfying that
 * route's schema (non-empty title, >= 1 step with non-empty action and
 * expectedResult, priority 1-4).
 */

/** Structural subset of the client's `BugReport` that the builders read. */
export type ReproductionBugReport = {
  title: string;
  precondition: string;
  stepsToReproduce: string;
  expectedResult: string;
  actualResult: string;
  systemInfo: string;
  priority: 1 | 2 | 3 | 4;
  environment?: string;
  category?: string;
};

export function buildSuggestedTestCaseFromBugReport(report: ReproductionBugReport, sourceBugDescription: string): GeneratedTestCase {
  const parsedSteps = parseBugSteps(report.stepsToReproduce);
  const reproductionSteps = parsedSteps.length ? parsedSteps : [report.stepsToReproduce || sourceBugDescription || report.title];
  const steps: GeneratedTestCase["steps"] = [
    {
      stepNumber: 1,
      action: `Preconditions:\n${report.precondition || "No specific preconditions were generated."}`,
      expectedResult: "Preconditions are met",
    },
    ...reproductionSteps.map((step, index) => ({
      stepNumber: index + 2,
      action: step,
      expectedResult: index === reproductionSteps.length - 1 ? report.expectedResult : "Step completes successfully.",
    })),
  ];

  return {
    id: createLocalId("bug-repro-tc"),
    title: buildReproductionTestCaseTitle(report),
    description: [
      sourceBugDescription.trim() ? `Bug description:\n${sourceBugDescription.trim()}` : "",
      report.actualResult ? `Actual result to prevent:\n${report.actualResult}` : "",
    ].filter(Boolean).join("\n\n"),
    priority: report.priority,
    type: "regression",
    category: report.category || "Functional",
    preconditions: report.precondition,
    testData: report.systemInfo || report.environment || "",
    steps,
  };
}

export function buildReproductionTestCaseTitle(report: ReproductionBugReport) {
  const expectedBehaviorTitle = testCaseTitleFromExpectedResult(report.expectedResult);
  if (expectedBehaviorTitle && !sameText(expectedBehaviorTitle, report.title)) return expectedBehaviorTitle;

  const firstStep = parseBugSteps(report.stepsToReproduce)[0];
  const stepTitle = firstStep ? compactText(`Verify reproduction flow: ${firstStep}`) : "";
  if (stepTitle && !sameText(stepTitle, report.title)) return truncateText(stepTitle, 140);

  const category = report.category || "reported defect";
  return `Verify ${category.toLowerCase()} reproduction scenario`;
}

export function testCaseTitleFromExpectedResult(value: string) {
  const expected = compactText(value).split(/(?<=[.!?])\s+|,\s+/)[0]?.replace(/[.!?]+$/, "").trim();
  if (!expected) return "";

  const systemShould = expected.match(/^the\s+system\s+should\s+(.+)$/i);
  if (systemShould?.[1]) return truncateText(`Verify the system ${systemShould[1]}`, 140);

  const shouldMatch = expected.match(/^(.+?)\s+should\s+(.+)$/i);
  if (shouldMatch?.[1] && shouldMatch[2]) {
    return truncateText(`Verify ${shouldMatch[1].trim()} ${shouldMatch[2].trim()}`, 140);
  }

  return truncateText(`Verify ${expected}`, 140);
}

export function createLocalId(prefix: string) {
  return `${prefix.replace(/[^a-z0-9]/gi, "-")}-${Math.random().toString(36).slice(2, 9)}`;
}

function compactText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number) {
  const normalized = compactText(value);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function sameText(first: string, second: string) {
  return compactText(first).toLowerCase() === compactText(second).toLowerCase();
}

function parseBugSteps(value: string) {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const numberedMatches = [...normalized.matchAll(/(?:^|\n)\s*(?:\d+[\).\:-]\s+)([\s\S]*?)(?=\n\s*\d+[\).\:-]\s+|$)/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  if (numberedMatches.length) return numberedMatches;
  return normalized.split("\n").map((line) => line.trim()).filter(Boolean);
}
