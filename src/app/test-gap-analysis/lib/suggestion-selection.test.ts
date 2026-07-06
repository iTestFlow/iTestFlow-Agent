import { describe, expect, it } from "vitest";

import type {
  ExistingTraceabilityRow,
  GeneratedTestCase,
} from "@/components/workflow/test-intelligence-types";
import {
  countInvalidSuggestions,
  countReviewGaps,
  selectSuggestedAdditions,
} from "./suggestion-selection";

function suggestion(id: string): GeneratedTestCase {
  return {
    id,
    title: id,
    description: "Description",
    priority: 2,
    type: "functional",
    category: "positive",
    preconditions: "Ready",
    steps: [{ stepNumber: 1, action: "Preconditions", expectedResult: "Preconditions are met" }],
  };
}

describe("suggestion selection", () => {
  it("returns selected additions in the displayed suggestion order", () => {
    expect(selectSuggestedAdditions(
      [suggestion("a"), suggestion("b"), suggestion("c")],
      ["c", "a"],
    ).map((item) => item.id)).toEqual(["a", "c"]);
  });

  it("ignores stale selected ids", () => {
    expect(selectSuggestedAdditions([suggestion("a")], ["missing"])).toEqual([]);
  });

  it("counts validation failures only among selected suggestions", () => {
    const selected = [suggestion("valid"), suggestion("invalid")];
    expect(countInvalidSuggestions(selected, (item) => ({ valid: item.id !== "invalid" }))).toBe(1);
  });

  it("counts partial, missing, and needs-review rows as review gaps", () => {
    const statuses: ExistingTraceabilityRow["coverageStatus"][] = [
      "Covered",
      "Partially covered",
      "Not covered",
      "Needs review",
    ];
    const rows = statuses.map((coverageStatus, index) => ({
      id: String(index),
      sourceType: "description" as const,
      sourceReference: "",
      requirementText: "",
      coverageStatus,
      severity: "Medium" as const,
      evidenceSummary: "",
      missingCoverage: "",
      recommendedMinimumTestCount: 0,
      recommendedAction: "",
      linkedTestCaseIds: [],
      notes: "",
    }));
    expect(countReviewGaps(rows)).toBe(3);
  });
});
