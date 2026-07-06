import { describe, expect, it } from "vitest";

import {
  azureIdSchema,
  extractAzureId,
  normalizeTestCasePriority,
} from "@/modules/integrations/azure-devops/publish-normalization";

describe("normalizeTestCasePriority", () => {
  it("maps priority labels onto the Azure 1-4 scale", () => {
    expect(normalizeTestCasePriority("critical")).toBe(1);
    expect(normalizeTestCasePriority("high")).toBe(2);
    expect(normalizeTestCasePriority("medium")).toBe(3);
    expect(normalizeTestCasePriority("low")).toBe(4);
  });

  it("accepts numeric and string-digit priorities as the same value", () => {
    expect(normalizeTestCasePriority(1)).toBe(1);
    expect(normalizeTestCasePriority("1")).toBe(1);
    expect(normalizeTestCasePriority(4)).toBe(4);
    expect(normalizeTestCasePriority("4")).toBe(4);
  });

  it("defaults missing priorities to 2", () => {
    expect(normalizeTestCasePriority(undefined)).toBe(2);
    expect(normalizeTestCasePriority(null)).toBe(2);
    expect(normalizeTestCasePriority("")).toBe(2);
  });

  it("passes unrecognized values through so the downstream schema rejects them", () => {
    expect(normalizeTestCasePriority("urgent")).toBe("urgent");
    expect(normalizeTestCasePriority(5)).toBe(5);
  });
});

describe("extractAzureId", () => {
  it("accepts a bare numeric ID, trimming surrounding whitespace", () => {
    expect(extractAzureId("123", "plan")).toBe("123");
    expect(extractAzureId("  123  ", "suite")).toBe("123");
  });

  it("extracts the kind-matching parameter from URL query forms", () => {
    expect(extractAzureId("https://dev.azure.com/org/p/_testPlans/define?planId=45", "plan")).toBe("45");
    expect(extractAzureId("https://dev.azure.com/org/p/_testPlans/define?planId=45&suiteId=7", "suite")).toBe("7");
    // Kind mismatch must not fall back to the other parameter.
    expect(extractAzureId("?suiteId=7", "plan")).toBeUndefined();
    expect(extractAzureId("?planId=45", "suite")).toBeUndefined();
  });

  it("extracts IDs from REST-style path forms", () => {
    expect(extractAzureId("https://dev.azure.com/org/p/_apis/testplan/plans/123/", "plan")).toBe("123");
    expect(extractAzureId("/plans/123/suites/456", "suite")).toBe("456");
    expect(extractAzureId("/plans/123", "plan")).toBe("123");
  });

  it("returns undefined for values with no extractable ID", () => {
    expect(extractAzureId("not-a-plan", "plan")).toBeUndefined();
    expect(extractAzureId("/plans/abc/", "plan")).toBeUndefined();
  });
});

describe("azureIdSchema", () => {
  it("transforms accepted forms to the numeric ID string", () => {
    expect(azureIdSchema("plan").parse("123")).toBe("123");
    expect(azureIdSchema("plan").parse("?planId=45")).toBe("45");
    expect(azureIdSchema("suite").parse("&suiteId=7")).toBe("7");
    expect(azureIdSchema("plan").parse("/plans/123/")).toBe("123");
  });

  it("rejects garbage with a kind-specific message", () => {
    const plan = azureIdSchema("plan").safeParse("garbage");
    expect(plan.success).toBe(false);
    expect(plan.error?.issues[0]?.message).toBe("Enter a valid Azure Test Plan ID or URL.");

    const suite = azureIdSchema("suite").safeParse("garbage");
    expect(suite.success).toBe(false);
    expect(suite.error?.issues[0]?.message).toBe("Enter a valid Azure Test Suite ID or URL.");
  });

  it("rejects the empty string before attempting extraction", () => {
    expect(azureIdSchema("plan").safeParse("").success).toBe(false);
  });
});
