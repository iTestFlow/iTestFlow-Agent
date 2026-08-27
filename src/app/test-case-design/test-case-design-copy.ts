import type { ProviderId } from "@/modules/integrations/core/provider-types";

export const TEST_CASE_DESIGN_PAGE_DESCRIPTION =
  "Generate test cases from a selected project work item with automatic project context selection.";

export function normalizeTestCaseDesignProviderId(value: unknown): ProviderId | null {
  return value === "azure-devops" || value === "jira-cloud" ? value : null;
}

export function testCaseDesignProviderCopy(providerId: ProviderId | null) {
  if (providerId === "azure-devops") {
    return { generationTitle: "Generate Test Cases from Azure DevOps Requirement" };
  }
  if (providerId === "jira-cloud") {
    return { generationTitle: "Generate Test Cases from a Jira Issue" };
  }
  return { generationTitle: "Generate Test Cases from a Work Item" };
}
