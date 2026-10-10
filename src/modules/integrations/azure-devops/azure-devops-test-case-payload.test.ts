import { describe, expect, it } from "vitest";

import { buildAzurePublishedSteps, buildAzureTestCasePatch, toAzureStepsXml } from "./azure-devops-test-case-payload";
import { withSuggestionOrigin } from "@/modules/test-case-design/test-case-basis";
import type { TestStep } from "./azure-devops-types";

const steps: TestStep[] = [
  {
    action: "Preconditions:\n1. User is signed in\n2. Quote LIST is active",
    expectedResult: "Preconditions are met",
  },
  {
    action: "Open the quote list page",
    expectedResult: "The received quote count is visible",
  },
];

describe("buildAzurePublishedSteps", () => {
  it("keeps multi-line preconditions as one Azure step row", () => {
    const published = buildAzurePublishedSteps({ steps, testData: "" });
    const xml = toAzureStepsXml(published);

    expect(published).toHaveLength(2);
    expect(published[0]).toEqual(steps[0]);
    expect(xml.match(/<step /g) ?? []).toHaveLength(2);
    expect(xml).toContain("Preconditions:");
    expect(xml).toContain("1. User is signed in");
    expect(xml).toContain("2. Quote LIST is active");
  });

  it("inserts test data immediately after preconditions", () => {
    const published = buildAzurePublishedSteps({
      steps,
      testData: "Customer has three received quotes.",
    });

    expect(published.map((step) => step.action)).toEqual([
      steps[0].action,
      "Test Setup & Data:\nCustomer has three received quotes.",
      steps[1].action,
    ]);
    expect(published[1]?.expectedResult).toBe("Required test setup and data are ready for use.");
  });
  it("carries the suggestion origin in Azure description without changing expected results", () => {
    const testCase = withSuggestionOrigin({ localId: "optional", targetUserStoryId: "101", title: "Keyboard path", priority: 2 as const, description: "Review keyboard path", steps,
      basis: { kind: "suggested" as const, explanation: "Assume logical focus order for checkout controls.", sourceReferences: ["WI:101"] } });
    const patch = buildAzureTestCasePatch(testCase);
    expect(patch.find((item) => item.path === "/fields/System.Description")?.value).toBe(testCase.description);
    expect(testCase.description).toContain("Suggested coverage — proposed assumption:");
    expect(patch.find((item) => item.path === "/fields/Microsoft.VSTS.TCM.Steps")?.value).toBe(toAzureStepsXml(steps));
  });

});
