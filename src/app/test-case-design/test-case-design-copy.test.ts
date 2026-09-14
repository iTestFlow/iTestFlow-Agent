import { describe, expect, it } from "vitest";

import {
  TEST_CASE_DESIGN_PAGE_DESCRIPTION,
  normalizeTestCaseDesignProviderId,
  testCaseDesignProviderCopy,
} from "./test-case-design-copy";

describe("test case design provider copy", () => {
  it("keeps the server-rendered page shell provider-neutral", () => {
    expect(TEST_CASE_DESIGN_PAGE_DESCRIPTION).toBe(
      "Generate test cases from a selected project work item with automatic project context selection.",
    );
    expect(TEST_CASE_DESIGN_PAGE_DESCRIPTION).not.toMatch(/Azure|Jira/);
  });

  it("uses neutral copy until a supported provider resolves", () => {
    expect(normalizeTestCaseDesignProviderId(undefined)).toBeNull();
    expect(normalizeTestCaseDesignProviderId("unknown-provider")).toBeNull();
    expect(testCaseDesignProviderCopy(null)).toEqual({
      generationTitle: "Generate Test Cases from a Work Item",
    });
  });

  it("uses Jira issue terminology for Jira Cloud", () => {
    expect(normalizeTestCaseDesignProviderId("jira-cloud")).toBe("jira-cloud");
    expect(testCaseDesignProviderCopy("jira-cloud")).toEqual({
      generationTitle: "Generate Test Cases from a Jira Issue",
    });
  });

  it("retains Azure requirement terminology for Azure DevOps", () => {
    expect(normalizeTestCaseDesignProviderId("azure-devops")).toBe("azure-devops");
    expect(testCaseDesignProviderCopy("azure-devops")).toEqual({
      generationTitle: "Generate Test Cases from Azure DevOps Requirement",
    });
  });
});
