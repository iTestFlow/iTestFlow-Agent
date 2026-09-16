import { describe, expect, it } from "vitest";

import { fakeLlmProvider, projectScope, requirement } from "@/test/factories";
import { normalizeRequirementAnalysisChecklistScope, runRequirementAnalysis } from "./requirement-analysis.service";
import type { RequirementAnalysisOutput } from "../schemas/requirement-analysis.schema";

const baseFinding = {
  issueType: "ambiguity",
  severity: "medium",
  title: "Finding title",
  description: "Finding description",
  suggestion: "Finding suggestion",
  riskLevel: "medium",
  riskJustification: "Risk justification",
  affectedAreas: [],
  references: [],
  contradiction: false,
} satisfies Omit<RequirementAnalysisOutput["findings"][number], "id" | "checklistItemId">;

const output: RequirementAnalysisOutput = {
  findings: [
    {
      ...baseFinding,
      id: "F-001",
      checklistItemId: "ambiguity_clarity",
      severity: "high",
    },
    {
      ...baseFinding,
      id: "F-009",
      checklistItemId: "localization_rtl_ltr",
      severity: "low",
    },
  ],
  summary: {
    totalFindings: 2,
    criticalCount: 0,
    highCount: 1,
    mediumCount: 0,
    lowCount: 1,
    infoCount: 0,
    overallQuality: "fair",
    completenessScore: 72,
    clarityScore: 65,
    testabilityScore: 70,
    summaryText: "Two findings were reported.",
  },
  recommendations: [],
  questionsForProductOwner: [],
  contextUsed: [],
};

describe("normalizeRequirementAnalysisChecklistScope", () => {
  it("drops findings for disabled checklist items and recalculates summary counts", () => {
    const result = normalizeRequirementAnalysisChecklistScope(output, ["ambiguity_clarity"]);

    expect(result.output.findings).toHaveLength(1);
    expect(result.output.findings[0]?.id).toBe("F-001");
    expect(result.output.summary).toMatchObject({
      totalFindings: 1,
      criticalCount: 0,
      highCount: 1,
      mediumCount: 0,
      lowCount: 0,
      infoCount: 0,
    });
    expect(result.warnings?.[0]).toContain("F-009 uses localization_rtl_ltr");
    expect(result.droppedFindings).toEqual([{ id: "F-009", checklistItemId: "localization_rtl_ltr" }]);
  });

  it("keeps the original output object when all findings use enabled checklist items", () => {
    const result = normalizeRequirementAnalysisChecklistScope(output, ["ambiguity_clarity", "localization_rtl_ltr"]);

    expect(result.output).toBe(output);
    expect(result.warnings).toBeUndefined();
    expect(result.droppedFindings).toEqual([]);
  });
});

describe("runRequirementAnalysis attachment evidence", () => {
  it("sends selected attachment text and derived visuals to the structured provider call", async () => {
    const provider = fakeLlmProvider({ structuredOutput: output });
    const image = {
      mediaType: "image/png" as const,
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    };

    const result = await runRequirementAnalysis({
      scope: projectScope(),
      actor: "qa",
      provider,
      targetRequirement: requirement(),
      selectedContext: [],
      storyAttachments: [{
        id: "attachment-checkout-design",
        fileName: "checkout-design.png",
        mimeType: "image/png",
        text: "The amount confirmation is shown before submit.",
        visualCount: 1,
      }],
      attachmentImages: [image],
    });

    expect(provider.generateStructuredOutput).toHaveBeenCalledWith(expect.objectContaining({
      images: [image],
      user: expect.stringContaining("checkout-design.png"),
    }));
    expect(result).toMatchObject({
      includedStoryAttachmentTextIds: ["attachment-checkout-design"],
      omittedStoryAttachmentTextIds: [],
    });
  });
});
