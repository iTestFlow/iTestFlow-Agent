import "server-only";

import { writeAuditLog } from "@/modules/audit/audit.service";
import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";

import type { AzureDevOpsAdapter } from "./azure-devops-adapter";

/**
 * Suite-scoped test-case retrieval for Test Execution's Test Plan/Suite
 * ingestion: test points supply the suite's test-case ids (the established
 * suite-migration idiom), then a batch fetch maps them to TestCase[] with
 * parsed steps. Mirrors azure-devops-linked-test-cases.service.ts.
 */
export async function fetchProjectScopedSuiteTestCases(
  adapter: AzureDevOpsAdapter,
  scopeInput: ProjectScope,
  input: { actor: string; testPlanId: string; testSuiteId: string },
) {
  const scope = assertProjectScope(scopeInput);
  const points = await adapter.fetchTestPoints({
    projectId: scope.azureProjectId,
    testPlanId: input.testPlanId,
    testSuiteId: input.testSuiteId,
  });
  const testCaseIds = [...new Set(points.map((point) => point.testCaseId).filter((id): id is string => Boolean(id)))];
  const testCases = testCaseIds.length > 0
    ? await adapter.fetchTestCasesByIds({ projectId: scope.azureProjectId, testCaseIds })
    : [];

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    actor: input.actor,
    entityType: "test_suite",
    entityId: input.testSuiteId,
    action: "azure_devops.fetch_suite_test_cases",
    status: "Success",
    message: `Fetched ${testCases.length} test case(s) from suite ${input.testSuiteId} (plan ${input.testPlanId}).`,
    details: { testPlanId: input.testPlanId, pointCount: points.length, testCaseCount: testCases.length },
  });
  return testCases;
}
