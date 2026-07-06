import { describe, expect, it } from "vitest";

import { coverageFocusOptions } from "@/modules/test-case-design/test-design-options";
import { buildTestCaseGenerationSystemPrompt } from "@/modules/llm/prompts/test-case-generation.prompt";

// The `- id: title` bullets between the scope header and its trailing blank line.
function enabledScopeLines(prompt: string) {
  const block = prompt.split("Enabled Coverage Focus items for this run:\n")[1] ?? "";
  return block.split("\n\n")[0]!.split("\n");
}

// Selected coverage-focus sections are the only "### " headings in the prompt.
function focusSectionHeadings(prompt: string) {
  return prompt.match(/^### .+$/gm) ?? [];
}

describe("buildTestCaseGenerationSystemPrompt", () => {
  it("emits every coverage-focus section for default options, in canonical order", () => {
    const prompt = buildTestCaseGenerationSystemPrompt();

    expect(enabledScopeLines(prompt)).toEqual(
      coverageFocusOptions.map((option) => `- ${option.id}: ${option.title}`),
    );
    expect(focusSectionHeadings(prompt)).toEqual(
      coverageFocusOptions.map((option) => `### ${option.title}`),
    );
  });

  it("emits exactly the selected focus sections in canonical order and omits the rest", () => {
    // Caller order (accessibility first) must not survive normalization.
    const prompt = buildTestCaseGenerationSystemPrompt({
      coverageFocusIds: ["accessibility", "functional"],
    });

    expect(enabledScopeLines(prompt)).toEqual([
      "- functional: Functional",
      "- accessibility: Accessibility",
    ]);
    expect(focusSectionHeadings(prompt)).toEqual(["### Functional", "### Accessibility"]);
    expect(prompt).not.toContain("- regression_impact:");
    expect(prompt).not.toContain("### Regression Impact");
  });

  it("throws when the selection normalizes to empty", () => {
    expect(() => buildTestCaseGenerationSystemPrompt({ coverageFocusIds: [] }))
      .toThrow(/At least one coverage focus item/);
  });

  // The internal "Unknown coverage focus item" throw is unreachable via this public
  // path: normalizeTestDesignOptions strips unknown ids before section lookup.
  it("drops unknown focus ids during normalization instead of throwing", () => {
    const prompt = buildTestCaseGenerationSystemPrompt({
      coverageFocusIds: ["functional", "made_up_focus" as never],
    });

    expect(focusSectionHeadings(prompt)).toEqual(["### Functional"]);
  });
});
