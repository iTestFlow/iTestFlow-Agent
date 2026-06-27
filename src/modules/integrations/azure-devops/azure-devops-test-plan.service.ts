import "server-only";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { writeAuditLog } from "@/modules/audit/audit.service";
import type { AzureDevOpsAdapter } from "./azure-devops-adapter";
import type { FinalApprovedTestCase, TestSuite } from "./azure-devops-types";

type PublishSuiteMode = "existing" | "requirement" | "none";
type PublishStepResult = { success: boolean; error?: string };
type PublishSuiteResult = PublishStepResult & { suiteId?: string; suiteName?: string };
type PublishCaseResult = {
  localId: string;
  azureTestCaseId?: string;
  success: boolean;
  create: PublishStepResult;
  link: PublishStepResult;
  suite?: PublishSuiteResult;
  error?: string;
};

export async function publishApprovedTestCases(
  adapter: AzureDevOpsAdapter,
  scopeInput: ProjectScope,
  input: {
    actor: string;
    targetUserStoryId: string;
    testPlanId?: string;
    suiteMode: PublishSuiteMode;
    testSuiteId?: string;
    parentSuiteId?: string;
    testCases: FinalApprovedTestCase[];
  },
) {
  const scope = assertProjectScope(scopeInput);
  const results: PublishCaseResult[] = [];

  if (input.suiteMode === "requirement") {
    const testPlanId = input.testPlanId ?? "";
    const parentSuiteId = input.parentSuiteId ?? "";
    const suiteTree = await adapter.fetchTestSuiteTree({
      projectId: scope.azureProjectId,
      testPlanId,
    });
    const parentSuite = findSuiteById(suiteTree, parentSuiteId);
    if (!parentSuite) {
      throw new Error(`Parent suite ${parentSuiteId} was not found in test plan ${testPlanId}.`);
    }
    if (parentSuite.suiteType !== "staticTestSuite") {
      throw new Error("Only static suites can be selected as a parent for a requirement-based suite.");
    }
  }

  for (const testCase of input.testCases) {
    const created = await adapter.createTestCase({ projectId: scope.azureProjectId, testCase });
    if (!created.success || !created.azureTestCaseId) {
      results.push({
        localId: testCase.localId,
        azureTestCaseId: created.azureTestCaseId,
        success: false,
        create: created,
        link: { success: false, error: "Skipped because test case creation failed." },
        ...(input.suiteMode === "none"
          ? {}
          : { suite: { success: false, error: "Skipped because test case creation failed." } }),
        error: created.error,
      });
      continue;
    }

    const link = await adapter.linkTestCaseToUserStory({
      projectId: scope.azureProjectId,
      userStoryId: input.targetUserStoryId,
      azureTestCaseId: created.azureTestCaseId,
    });
    let suite: PublishSuiteResult | undefined;

    if (input.suiteMode === "existing") {
      suite = link.success
        ? await adapter.addTestCaseToSuite({
            projectId: scope.azureProjectId,
            testPlanId: input.testPlanId ?? "",
            testSuiteId: input.testSuiteId ?? "",
            azureTestCaseId: created.azureTestCaseId,
          })
        : { success: false, error: "Skipped because user story link failed." };
    }

    results.push({
      localId: testCase.localId,
      azureTestCaseId: created.azureTestCaseId,
      success: input.suiteMode === "existing" ? created.success && link.success && Boolean(suite?.success) : created.success && link.success,
      create: created,
      link,
      ...(suite ? { suite } : {}),
    });
  }

  let requirementSuite: PublishSuiteResult | undefined;

  if (input.suiteMode === "requirement") {
    const linkedCount = results.filter((result) => result.link.success).length;
    if (linkedCount > 0) {
      const createdSuite = await adapter.createRequirementBasedSuite({
        projectId: scope.azureProjectId,
        testPlanId: input.testPlanId ?? "",
        parentSuiteId: input.parentSuiteId ?? "",
        requirementId: input.targetUserStoryId,
        name: `US ${input.targetUserStoryId} - Generated Test Cases`,
      });
      requirementSuite = {
        success: createdSuite.success,
        suiteId: createdSuite.suite?.id,
        suiteName: createdSuite.suite?.name,
        error: createdSuite.error,
      };
      results.forEach((result) => {
        result.suite = result.link.success
          ? requirementSuite ?? { success: false, error: "Requirement suite creation did not return a result." }
          : { success: false, error: "Skipped because user story link failed." };
        result.success = result.success && Boolean(requirementSuite?.success);
      });
    } else {
      requirementSuite = { success: false, error: "Skipped because no generated test cases were linked to the user story." };
      results.forEach((result) => {
        result.suite = requirementSuite ?? { success: false, error: "Requirement suite creation did not return a result." };
        result.success = false;
      });
    }
  }

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    actor: input.actor,
    entityType: "work_item",
    entityId: input.targetUserStoryId,
    action: "azure_devops.publish_test_cases",
    status: results.every((result) => result.success) ? "Success" : results.some((result) => result.success) ? "Partial failure" : "Failed",
    message:
      input.suiteMode === "none"
        ? `Created and linked ${results.filter((result) => result.success).length} of ${input.testCases.length} selected test cases.`
        : `Published ${results.filter((result) => result.success).length} of ${input.testCases.length} selected test cases.`,
    details: {
      testPlanId: input.testPlanId,
      testSuiteId: input.testSuiteId,
      parentSuiteId: input.parentSuiteId,
      suiteMode: input.suiteMode,
      requirementSuite,
      results,
    },
  });

  return { results, requirementSuite };
}

function findSuiteById(suites: TestSuite[], suiteId: string): TestSuite | undefined {
  for (const suite of suites) {
    if (suite.id === suiteId) return suite;
    const child = findSuiteById(suite.children ?? [], suiteId);
    if (child) return child;
  }
  return undefined;
}
