import { describe, expect, it, vi } from "vitest";

vi.mock("@/modules/audit/audit.service", () => ({
  writeAuditLog: vi.fn(),
}));

import { fakeLlmProvider, projectScope, requirement } from "@/test/factories";
import { suggestContextStories } from "./context-selection.service";
import {
  ContextSuggestionItemSchema,
  ContextSuggestionOutputSchema,
} from "./context-selection.schema";

describe("context selection service", () => {
  it("sends trusted scope and bounded context options to the provider", async () => {
    const provider = fakeLlmProvider({
      structuredOutput: {
        suggestedItems: [{
          workItemId: "102",
          title: "Payment dependency",
          workItemType: "Feature",
          relevanceScore: 0.9,
          reason: "Related checkout flow",
        }],
      },
    });
    await expect(suggestContextStories({
      scope: projectScope(),
      actor: "qa",
      provider,
      targetRequirement: requirement(),
      retrievedContext: [{ id: "102" }],
      maxContextItems: 4,
    })).resolves.toMatchObject({
      validatedOutput: { suggestedItems: [expect.objectContaining({ workItemId: "102" })] },
    });
    expect(provider.generateStructuredOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaName: "ContextSuggestionOutput",
        user: expect.stringContaining("\"maxContextItems\":4"),
        metadata: expect.objectContaining({ targetWorkItemId: "101" }),
      }),
    );
  });
});

describe("ContextSuggestionOutputSchema", () => {
  const validItem = {
    workItemId: "102",
    title: "Payment dependency",
    workItemType: "Feature",
    relationshipType: "Related",
    relevanceScore: 0.9,
    reason: "Related checkout flow",
  };

  it("parses a full valid suggestion output", () => {
    const result = ContextSuggestionOutputSchema.safeParse({
      suggestedItems: [validItem],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.suggestedItems[0]).toMatchObject({
        workItemId: "102",
        relevanceScore: 0.9,
      });
    }
  });

  it("rejects a relevanceScore outside the 0..1 bound", () => {
    const result = ContextSuggestionItemSchema.safeParse({
      ...validItem,
      relevanceScore: 1.5,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["relevanceScore"]);
    }
  });

  it("rejects an item missing the required reason field", () => {
    const withoutReason: Partial<typeof validItem> = { ...validItem };
    delete withoutReason.reason;
    const result = ContextSuggestionItemSchema.safeParse(withoutReason);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes("reason"))).toBe(true);
    }
  });
});
