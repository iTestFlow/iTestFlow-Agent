import { describe, expect, it } from "vitest";

import {
  extractAzureId,
  isRequirementLikeType,
  normalizeTestCasePriority,
  qualityTone,
  scoreTone,
} from "@/components/workflow/test-intelligence-shared";

describe("extractAzureId", () => {
  it("passes a bare numeric ID through for both kinds", () => {
    expect(extractAzureId("123456", "plan")).toBe("123456");
    expect(extractAzureId("123456", "suite")).toBe("123456");
    expect(extractAzureId("  123456  ", "plan")).toBe("123456");
  });

  it("reads the kind-specific query parameter from a pasted link", () => {
    const url = "https://dev.azure.com/org/proj/_testPlans/define?planId=42&suiteId=99";
    expect(extractAzureId(url, "plan")).toBe("42");
    expect(extractAzureId(url, "suite")).toBe("99");
    // Query parameter names are matched case-insensitively.
    expect(extractAzureId("?PLANID=42&SUITEID=99", "plan")).toBe("42");
    expect(extractAzureId("?PLANID=42&SUITEID=99", "suite")).toBe("99");
  });

  it("reads path segments of the form /plans/<id>/suites/<id>", () => {
    const url = "https://dev.azure.com/org/proj/_apis/testplan/plans/123/suites/456";
    expect(extractAzureId(url, "plan")).toBe("123");
    expect(extractAzureId(url, "suite")).toBe("456");
    // Terminators after the ID: end of string and "?" both count.
    expect(extractAzureId("/plans/123", "plan")).toBe("123");
    expect(extractAzureId("/suites/456?x=1", "suite")).toBe("456");
  });

  it("requires a terminator after the path ID, so trailing junk does not match", () => {
    expect(extractAzureId("/plans/123abc", "plan")).toBe("");
    expect(extractAzureId("/suites/456abc", "suite")).toBe("");
  });

  it("prefers the query parameter when it disagrees with the path segment", () => {
    expect(extractAzureId("/plans/123?planId=42", "plan")).toBe("42");
    expect(extractAzureId("/suites/456?suiteId=99", "suite")).toBe("99");
  });

  it("returns an empty string for values with no recognizable ID", () => {
    expect(extractAzureId("not a link", "plan")).toBe("");
    expect(extractAzureId("", "suite")).toBe("");
    expect(extractAzureId("?suiteId=99", "plan")).toBe("");
  });
});

describe("normalizeTestCasePriority", () => {
  it.each([
    ["critical", 1],
    ["high", 2],
    ["medium", 3],
    ["low", 4],
  ] as const)("maps %s to %i", (label, priority) => {
    expect(normalizeTestCasePriority(label)).toBe(priority);
  });

  it("accepts numeric and numeric-string priorities 1-4", () => {
    expect(normalizeTestCasePriority(1)).toBe(1);
    expect(normalizeTestCasePriority("3")).toBe(3);
    expect(normalizeTestCasePriority(4)).toBe(4);
  });

  it("falls back to 2 for empty, null, or unrecognized values", () => {
    expect(normalizeTestCasePriority("")).toBe(2);
    expect(normalizeTestCasePriority(null)).toBe(2);
    expect(normalizeTestCasePriority(undefined)).toBe(2);
    expect(normalizeTestCasePriority("urgent")).toBe(2);
    expect(normalizeTestCasePriority(5)).toBe(2);
  });
});

describe("isRequirementLikeType", () => {
  it.each(["User Story", "Product Backlog Item", "Requirement", "Feature", "Bug"])(
    "accepts %s regardless of case and surrounding whitespace",
    (workItemType) => {
      expect(isRequirementLikeType(workItemType)).toBe(true);
      expect(isRequirementLikeType(`  ${workItemType.toUpperCase()}  `)).toBe(true);
    },
  );

  it("rejects other work item types", () => {
    expect(isRequirementLikeType("Task")).toBe(false);
    expect(isRequirementLikeType("Epic")).toBe(false);
    expect(isRequirementLikeType("")).toBe(false);
  });
});

describe("scoreTone", () => {
  // Thresholds: >= 80 success, >= 60 warning, else error.
  it.each([
    [100, "success"],
    [80, "success"],
    [79.9, "warning"],
    [60, "warning"],
    [59.9, "error"],
    [0, "error"],
  ] as const)("maps %d to %s", (score, tone) => {
    expect(scoreTone(score)).toBe(tone);
  });
});

describe("qualityTone", () => {
  it.each([
    ["excellent", "success"],
    ["good", "success"],
    ["fair", "warning"],
    ["poor", "error"],
    ["", "error"],
  ] as const)("maps %j to %s", (quality, tone) => {
    expect(qualityTone(quality)).toBe(tone);
  });
});
