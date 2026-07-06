import { describe, expect, it } from "vitest";

import { requirementAnalysisChecklistOptions } from "@/modules/requirement-analysis/checklist-options";
import {
  allRequirementAnalysisChecklistItemIds,
  buildRequirementAnalysisSystemPrompt,
  normalizeRequirementAnalysisChecklistItemIds,
} from "@/modules/llm/prompts/requirement-analysis.prompt";

// The `- id: title` bullets between the scope header and its trailing blank line.
function enabledScopeLines(prompt: string) {
  const block = prompt.split("Enabled checklist items for this run:\n")[1] ?? "";
  return block.split("\n\n")[0]!.split("\n");
}

// Numbered section headings of the master checklist; no other prompt line starts with "N. ".
function numberedSectionLines(prompt: string) {
  return prompt.match(/^\d+\. .+$/gm) ?? [];
}

describe("normalizeRequirementAnalysisChecklistItemIds", () => {
  it("returns every id in canonical order when the selection is undefined", () => {
    expect(normalizeRequirementAnalysisChecklistItemIds()).toEqual(allRequirementAnalysisChecklistItemIds);
  });

  it("reorders a subset into canonical master-list order regardless of caller order", () => {
    expect(normalizeRequirementAnalysisChecklistItemIds([
      "accessibility",
      "ambiguity_clarity",
      "completeness_testability",
    ])).toEqual(["completeness_testability", "ambiguity_clarity", "accessibility"]);
  });

  it("drops unknown ids", () => {
    expect(normalizeRequirementAnalysisChecklistItemIds(["security_privacy_compliance", "made_up_item"]))
      .toEqual(["security_privacy_compliance"]);
  });
});

describe("buildRequirementAnalysisSystemPrompt", () => {
  it("throws when the selection normalizes to empty", () => {
    expect(() => buildRequirementAnalysisSystemPrompt([]))
      .toThrow(/At least one requirement analysis checklist item/);
    // Unknown ids are stripped first, so an all-unknown selection hits the same guard.
    expect(() => buildRequirementAnalysisSystemPrompt(["made_up_item"]))
      .toThrow(/At least one requirement analysis checklist item/);
  });

  it("lists exactly the selected items in the enabled scope and numbered sections, in canonical order", () => {
    const prompt = buildRequirementAnalysisSystemPrompt(["accessibility", "ambiguity_clarity"]);

    expect(enabledScopeLines(prompt)).toEqual([
      "- ambiguity_clarity: Ambiguity and Clarity",
      "- accessibility: Accessibility",
    ]);
    expect(numberedSectionLines(prompt)).toEqual([
      "1. Ambiguity and Clarity",
      "2. Accessibility",
    ]);
    // Unselected checklist titles appear nowhere in the built prompt.
    expect(prompt).not.toContain("Requirement Completeness and Testability");
    expect(prompt).not.toContain("- completeness_testability:");
  });

  it("includes every checklist item when built with no selection", () => {
    const prompt = buildRequirementAnalysisSystemPrompt();

    expect(enabledScopeLines(prompt)).toEqual(
      requirementAnalysisChecklistOptions.map((option) => `- ${option.id}: ${option.title}`),
    );
    expect(numberedSectionLines(prompt)).toEqual(
      requirementAnalysisChecklistOptions.map((option, index) => `${index + 1}. ${option.title}`),
    );
  });
});
