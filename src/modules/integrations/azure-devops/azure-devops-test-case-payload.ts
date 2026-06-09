import type { FinalApprovedTestCase, TestStep } from "./azure-devops-types";

const TEST_SETUP_EXPECTED_RESULT = "Required test setup and data are ready for use.";

type AzurePatchOperation = {
  op: "add";
  path: string;
  value: unknown;
};

export function buildAzureTestCasePatch(testCase: FinalApprovedTestCase): AzurePatchOperation[] {
  return [
    { op: "add", path: "/fields/System.Title", value: testCase.title },
    { op: "add", path: "/fields/System.Description", value: testCase.description ?? "" },
    { op: "add", path: "/fields/Microsoft.VSTS.Common.Priority", value: testCase.priority },
    {
      op: "add",
      path: "/fields/Microsoft.VSTS.TCM.Steps",
      value: toAzureStepsXml(buildAzurePublishedSteps(testCase)),
    },
  ];
}

export function buildAzurePublishedSteps(
  testCase: Pick<FinalApprovedTestCase, "steps" | "testData">,
): TestStep[] {
  const testData = testCase.testData?.trim();
  if (!testData) return testCase.steps;

  const testDataStep: TestStep = {
    action: `Test Setup & Data:\n${testData}`,
    expectedResult: TEST_SETUP_EXPECTED_RESULT,
  };
  const preconditionsIndex = testCase.steps.findIndex((step) =>
    step.action.trim().toLowerCase().startsWith("preconditions"),
  );
  const insertionIndex = preconditionsIndex >= 0 ? preconditionsIndex + 1 : 0;

  return [
    ...testCase.steps.slice(0, insertionIndex),
    testDataStep,
    ...testCase.steps.slice(insertionIndex),
  ];
}

export function toAzureStepsXml(steps: TestStep[]) {
  const stepXml = steps
    .map(
      (step, index) =>
        `<step id="${index + 1}" type="ActionStep"><parameterizedString isformatted="true">${escapeXml(
          step.action,
        )}</parameterizedString><parameterizedString isformatted="true">${escapeXml(
          step.expectedResult,
        )}</parameterizedString><description/></step>`,
    )
    .join("");
  return `<steps id="0" last="${steps.length}">${stepXml}</steps>`;
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
