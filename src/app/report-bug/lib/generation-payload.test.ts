import { describe, expect, it } from "vitest";

import type { ActiveProjectScope } from "@/shared/lib/active-project";
import {
  buildBugGenerationPayload,
  buildSelectedRelatedTestCaseContext,
  testCaseId,
  type LinkedTestCase,
} from "./generation-payload";

const scope: ActiveProjectScope = {
  projectId: "project-1",
  azureProjectId: "azure-project-1",
  azureProjectName: "Demo",
  azureOrganizationUrl: "https://dev.azure.com/demo",
  workspaceId: "ws-1",
};
const linked: LinkedTestCase = {
  id: "local-1",
  azureTestCaseId: "201",
  title: "Checkout retry",
  description: "Retry a declined payment.",
  preconditions: "Cart exists.",
  steps: [{ action: "Submit payment", expectedResult: "Retry is offered" }],
  testData: "Declined card",
  expectedResult: "Order remains pending",
  priority: 2,
  testType: "functional",
};

describe("bug generation payload", () => {
  it("prefers the Azure test-case id for selection identity", () => {
    expect(testCaseId(linked)).toBe("201");
    expect(testCaseId({ ...linked, azureTestCaseId: undefined })).toBe("local-1");
  });

  it("returns no related context when selection is empty or stale", () => {
    expect(buildSelectedRelatedTestCaseContext("", [linked])).toBeUndefined();
    expect(buildSelectedRelatedTestCaseContext("missing", [linked])).toBeUndefined();
  });

  it("copies only the supported related-test-case context fields", () => {
    expect(buildSelectedRelatedTestCaseContext("201", [linked])).toEqual({
      id: "local-1",
      azureTestCaseId: "201",
      title: "Checkout retry",
      description: "Retry a declined payment.",
      preconditions: "Cart exists.",
      steps: [{ action: "Submit payment", expectedResult: "Retry is offered" }],
      testData: "Declined card",
      expectedResult: "Order remains pending",
      priority: 2,
      testType: "functional",
    });
  });

  it("builds the generation request with trimmed optional parent and attachment descriptors", () => {
    expect(buildBugGenerationPayload({
      scope,
      bugDescription: "Checkout fails.",
      parentStoryId: " 101 ",
      selectedTestCaseId: "201",
      linkedTestCases: [linked],
      customFields: [{ referenceName: "Custom.Impact", value: "High" }],
      attachments: [{ name: "error.txt", type: "", size: 42 }],
    })).toMatchObject({
      scope,
      bugDescription: "Checkout fails.",
      parentStoryId: "101",
      selectedRelatedTestCase: { azureTestCaseId: "201" },
      customFields: [{ referenceName: "Custom.Impact", value: "High" }],
      attachments: [{ fileName: "error.txt", contentType: undefined, size: 42 }],
    });
  });

  it("omits optional parent, related context, and blank content type", () => {
    expect(buildBugGenerationPayload({
      scope,
      bugDescription: "Checkout fails.",
      parentStoryId: " ",
      selectedTestCaseId: "",
      linkedTestCases: [],
      customFields: [],
      attachments: [],
    })).toEqual({
      scope,
      bugDescription: "Checkout fails.",
      parentStoryId: undefined,
      selectedRelatedTestCase: undefined,
      customFields: [],
      attachments: [],
    });
  });
});
