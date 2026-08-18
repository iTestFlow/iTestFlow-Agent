import "server-only";

import type { TestCase, TestPoint, TestSuite } from "@/modules/integrations/core/integration-types";
import { selectedSuiteIds } from "./suite-selection";

export type SuiteCaseSource = {
  fetchTestSuiteTree(input: { projectId: string; testPlanId: string }): Promise<TestSuite[]>;
  fetchTestPoints(input: { projectId: string; testPlanId: string; testSuiteId: string }): Promise<TestPoint[]>;
  fetchTestCasesByIds(input: { projectId: string; testCaseIds: string[] }): Promise<TestCase[]>;
};

export type DerivedExecutionCase = {
  testCaseId: number;
  testPointId: number;
  planId: number;
  suiteId: number;
  title: string;
  steps: Array<{ action: string; expectedResult?: string }>;
};

/**
 * Expands the selected suite (including descendants) into executable cases with
 * their test points. Shared by the pre-execution case preview and anything else
 * that needs the plan/suite scope without creating a run.
 */
export async function deriveSuiteExecutionCases(
  source: SuiteCaseSource,
  input: { azureProjectId: string; testPlanId: number; testSuiteId: number },
): Promise<DerivedExecutionCase[]> {
  const tree = await source.fetchTestSuiteTree({ projectId: input.azureProjectId, testPlanId: String(input.testPlanId) });
  const suiteIds = selectedSuiteIds(tree, String(input.testSuiteId));
  const pointGroups = await Promise.all(suiteIds.map((testSuiteId) => source.fetchTestPoints({
    projectId: input.azureProjectId,
    testPlanId: String(input.testPlanId),
    testSuiteId,
  })));
  const points = pointGroups.flat();
  const testCaseIds = [...new Set(points.map((point) => point.testCaseId).filter((id): id is string => Boolean(id)))];
  const testCases = testCaseIds.length
    ? await source.fetchTestCasesByIds({ projectId: input.azureProjectId, testCaseIds })
    : [];
  const caseById = new Map(testCases.map((testCase) => [testCase.azureTestCaseId ?? testCase.id, testCase]));
  const seen = new Set<string>();
  return points.flatMap((point) => {
    if (!point.testCaseId || seen.has(point.id)) return [];
    seen.add(point.id);
    const testCase = caseById.get(point.testCaseId);
    if (!testCase) return [];
    return [{
      testCaseId: Number(point.testCaseId),
      testPointId: Number(point.id),
      planId: input.testPlanId,
      suiteId: Number(point.suiteId ?? input.testSuiteId),
      title: testCase.title,
      steps: testCase.steps,
    }];
  });
}
