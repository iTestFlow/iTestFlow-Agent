import type { ActiveProjectScope } from "@/shared/lib/active-project";

import type { BugCustomField } from "./bug-custom-fields";

export type LinkedTestCase = {
  id: string;
  title: string;
  description?: string;
  preconditions?: string;
  steps: Array<{ action: string; expectedResult: string }>;
  testData?: string;
  expectedResult?: string;
  priority?: 1 | 2 | 3 | 4;
  testType?: string;
  automationSuitability?: string;
  azureTestCaseId?: string;
};

export function testCaseId(testCase: LinkedTestCase) {
  return testCase.azureTestCaseId ?? testCase.id;
}

export function buildSelectedRelatedTestCaseContext(
  selectedTestCaseId: string,
  linkedTestCases: readonly LinkedTestCase[],
) {
  if (!selectedTestCaseId) return undefined;
  const selected = linkedTestCases.find(
    (testCase) => testCaseId(testCase) === selectedTestCaseId,
  );
  if (!selected) return undefined;
  return {
    id: selected.id,
    azureTestCaseId: selected.azureTestCaseId,
    title: selected.title,
    description: selected.description,
    preconditions: selected.preconditions,
    steps: (selected.steps ?? []).map((step) => ({
      action: step.action,
      expectedResult: step.expectedResult,
    })),
    testData: selected.testData,
    expectedResult: selected.expectedResult,
    priority: selected.priority,
    testType: selected.testType,
  };
}

export function buildBugGenerationPayload(input: {
  scope: ActiveProjectScope;
  bugDescription: string;
  parentStoryId: string;
  selectedTestCaseId: string;
  linkedTestCases: readonly LinkedTestCase[];
  customFields: BugCustomField[];
  attachments: ReadonlyArray<Pick<File, "name" | "type" | "size">>;
}) {
  return {
    scope: input.scope,
    bugDescription: input.bugDescription,
    parentStoryId: input.parentStoryId.trim() || undefined,
    selectedRelatedTestCase: buildSelectedRelatedTestCaseContext(
      input.selectedTestCaseId,
      input.linkedTestCases,
    ),
    customFields: input.customFields,
    attachments: input.attachments.map((file) => ({
      fileName: file.name,
      contentType: file.type || undefined,
      size: file.size,
    })),
  };
}
