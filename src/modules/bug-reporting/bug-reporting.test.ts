import { describe, expect, it, vi } from "vitest";

vi.mock("@/modules/audit/audit.service", () => ({
  writeAuditLog: vi.fn(),
}));

import { fakeLlmProvider, projectScope, requirement } from "@/test/factories";
import {
  buildBugReportPromptDraft,
  completeManualBugReport,
  generateBugReport,
} from "./bug-reporting.service";
import {
  BugPrioritySchema,
  BugRelatedTestCaseContextSchema,
  BugSeveritySchema,
  FinalBugReportSchema,
  GeneratedBugReportSchema,
} from "./schemas/bug-report.schema";

describe("bug reporting", () => {
  it.each([
    ["critical", "1 - Critical"],
    ["2", "2 - High"],
    ["3 - medium (default)", "3 - Medium"],
    [4, "4 - Low"],
  ])("normalizes severity %s", (input, expected) => {
    expect(BugSeveritySchema.parse(input)).toBe(expected);
  });

  it.each([
    [1, "1 - Critical"],
    [2, "2 - High"],
    [3, "3 - Medium"],
    ["4 - informational", "4 - Low"],
  ])("normalizes additional severity form %s", (input, expected) => {
    expect(BugSeveritySchema.parse(input)).toBe(expected);
  });

  it.each([["highest", 1], ["2 - current sprint", 2], ["3 - soon", 3], ["lowest", 4]])(
    "normalizes priority %s",
    (input, expected) => expect(BugPrioritySchema.parse(input)).toBe(expected),
  );

  it.each([[1, 1], [2, 2], [3, 3], [4, 4], ["1 urgent", 1], ["4 later", 4]])(
    "normalizes additional priority form %s",
    (input, expected) => expect(BugPrioritySchema.parse(input)).toBe(expected),
  );

  it("rejects unsupported priority and severity values", () => {
    expect(BugPrioritySchema.safeParse("urgent").success).toBe(false);
    expect(BugSeveritySchema.safeParse("catastrophic").success).toBe(false);
  });

  it("applies safe defaults to a valid generated bug", () => {
    expect(GeneratedBugReportSchema.parse({
      title: "Checkout fails",
      precondition: "Cart contains an item",
      stepsToReproduce: "Submit payment",
      expectedResult: "Order is placed",
      actualResult: "An error appears",
      severity: "high",
      priority: "2",
    })).toMatchObject({
      systemInfo: "Not specified",
      environment: "2. Testing/QC",
      category: "Functional",
      customFields: [],
      contextUsed: [],
    });
  });

  it("builds a grounded manual prompt without leaking HTML", () => {
    const draft = buildBugReportPromptDraft({
      scope: projectScope(),
      bugDescription: " Payment fails ",
      parentStory: requirement({ description: "<p>Checkout story</p>" }),
      attachments: [{ fileName: "screen.png", size: 10 }],
      customFields: [{ referenceName: "Custom.Channel", value: "Web" }],
      projectKnowledgeNotice: "Current raw work-item evidence wins every conflict.",
    });
    expect(draft.schemaName).toBe("BugReportGenerationOutput");
    expect(draft.userPrompt).toContain("Payment fails");
    expect(draft.userPrompt).toContain("Checkout story");
    expect(draft.userPrompt).toContain("screen.png");
    expect(draft.userPrompt).toContain("# Knowledge Authority");
    expect(draft.userPrompt).toContain("Current raw work-item evidence wins every conflict.");
    expect(draft.prompt).toContain(draft.systemPrompt);
  });

  it("uses the same validated bug contract for automatic and manual generation", async () => {
    const generated = GeneratedBugReportSchema.parse({
      title: "Checkout fails",
      precondition: "Cart contains an item",
      stepsToReproduce: "Submit payment",
      expectedResult: "Order is placed",
      actualResult: "An error appears",
      severity: "high",
      priority: "2",
    });
    const provider = fakeLlmProvider({ structuredOutput: generated });
    await expect(generateBugReport({
      scope: projectScope(),
      actor: "qa",
      provider,
      bugDescription: "Checkout fails",
      parentStory: requirement(),
    })).resolves.toMatchObject({ validatedOutput: generated });
    expect(provider.generateStructuredOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaName: "BugReportGenerationOutput",
        metadata: expect.objectContaining({ targetWorkItemId: "101" }),
      }),
    );

    expect(completeManualBugReport({
      scope: projectScope(),
      actor: "qa",
      rawOutput: JSON.stringify(generated),
      parentStoryId: "101",
    })).toMatchObject({ provider: "external", validatedOutput: generated });
  });

  it("parses a full related test case context with steps and optional ids", () => {
    expect(BugRelatedTestCaseContextSchema.parse({
      id: "tc-1",
      azureTestCaseId: "12345",
      title: "Login works",
      description: "Verifies login",
      preconditions: "User exists",
      steps: [
        { action: "Open login page", expectedResult: "Form shown" },
        { action: "Submit credentials", expectedResult: "Dashboard shown" },
      ],
      testData: "user@example.com",
      expectedResult: "User is authenticated",
      priority: "2",
      testType: "Functional",
    })).toEqual({
      id: "tc-1",
      azureTestCaseId: "12345",
      title: "Login works",
      description: "Verifies login",
      preconditions: "User exists",
      steps: [
        { action: "Open login page", expectedResult: "Form shown" },
        { action: "Submit credentials", expectedResult: "Dashboard shown" },
      ],
      testData: "user@example.com",
      expectedResult: "User is authenticated",
      priority: 2,
      testType: "Functional",
    });
  });

  it("defaults steps to an empty array for a minimal related test case context", () => {
    const parsed = BugRelatedTestCaseContextSchema.parse({ title: "Smoke check" });
    expect(parsed).toEqual({ title: "Smoke check", steps: [] });
  });

  it("enforces the final bug report title boundary at 200 characters", () => {
    const base = {
      title: "x",
      precondition: "Cart contains an item",
      stepsToReproduce: "Submit payment",
      expectedResult: "Order is placed",
      actualResult: "An error appears",
      severity: "high",
      priority: "2",
    };
    expect(FinalBugReportSchema.parse({ ...base, title: "a".repeat(200) }).title).toBe("a".repeat(200));
    expect(FinalBugReportSchema.safeParse({ ...base, title: "a".repeat(201) }).success).toBe(false);
  });
});
