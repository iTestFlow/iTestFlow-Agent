import "server-only";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { writeAuditLog } from "@/modules/audit/audit.service";
import type { AzureDevOpsAdapter } from "./azure-devops-adapter";
import type { FinalApprovedTestCase } from "./azure-devops-types";

export async function publishApprovedTestCases(
  adapter: AzureDevOpsAdapter,
  scopeInput: ProjectScope,
  input: {
    targetUserStoryId: string;
    testPlanId: string;
    testSuiteId: string;
    testCases: FinalApprovedTestCase[];
  },
) {
  const scope = assertProjectScope(scopeInput);
  const results = [];

  for (const testCase of input.testCases) {
    const created = await adapter.createTestCase({ projectId: scope.azureProjectId, testCase });
    if (!created.success || !created.azureTestCaseId) {
      results.push({ localId: testCase.localId, success: false, error: created.error });
      continue;
    }

    const suite = await adapter.addTestCaseToSuite({
      projectId: scope.azureProjectId,
      testPlanId: input.testPlanId,
      testSuiteId: input.testSuiteId,
      azureTestCaseId: created.azureTestCaseId,
    });
    const link = suite.success
      ? await adapter.linkTestCaseToUserStory({
          projectId: scope.azureProjectId,
          userStoryId: input.targetUserStoryId,
          azureTestCaseId: created.azureTestCaseId,
        })
      : { success: false, error: suite.error };

    results.push({
      localId: testCase.localId,
      azureTestCaseId: created.azureTestCaseId,
      success: created.success && suite.success && link.success,
      create: created,
      suite,
      link,
    });
  }

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    entityType: "work_item",
    entityId: input.targetUserStoryId,
    action: "azure_devops.publish_test_cases",
    status: results.every((result) => result.success) ? "Success" : "Partial failure",
    message: `Published ${results.filter((result) => result.success).length} of ${input.testCases.length} selected test cases.`,
    details: { testPlanId: input.testPlanId, testSuiteId: input.testSuiteId, results },
  });

  return results;
}
