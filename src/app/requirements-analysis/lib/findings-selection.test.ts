import { describe, expect, it } from "vitest";

import type { RequirementFinding } from "@/components/workflow/test-intelligence-types";
import {
  countInvalidFindings,
  selectFindings,
  sortFindingsBySeverity,
  toggleOrderedSelection,
  toggleUniqueId,
} from "./findings-selection";

function finding(id: string, severity: RequirementFinding["severity"]): RequirementFinding {
  return {
    id,
    checklistItemId: "ambiguity_clarity",
    issueType: "ambiguity",
    severity,
    title: id,
    description: "Description",
    suggestion: "Suggestion",
    riskLevel: "medium",
    riskJustification: "Risk",
    affectedAreas: [],
    references: [],
    contradiction: false,
  };
}

describe("findings selection", () => {
  it("sorts critical findings first without mutating the source list", () => {
    const source = [finding("low", "low"), finding("critical", "critical")];
    expect(sortFindingsBySeverity(source).map((item) => item.id)).toEqual(["critical", "low"]);
    expect(source.map((item) => item.id)).toEqual(["low", "critical"]);
  });

  it("selects in review order rather than caller id order", () => {
    const sorted = [finding("critical", "critical"), finding("low", "low")];
    expect(selectFindings(sorted, ["low", "critical"]).map((item) => item.id))
      .toEqual(["critical", "low"]);
  });

  it("counts invalid selected findings through the public validator contract", () => {
    const selected = [finding("valid", "high"), finding("invalid", "medium")];
    expect(countInvalidFindings(selected, (item) => ({ valid: item.id !== "invalid" }))).toBe(1);
  });

  it("toggles checklist ids while preserving canonical option order", () => {
    const order = ["clarity", "completeness", "testability"] as const;
    expect(toggleOrderedSelection(order, ["testability"], "clarity", true))
      .toEqual(["clarity", "testability"]);
    expect(toggleOrderedSelection(order, ["clarity", "testability"], "clarity", false))
      .toEqual(["testability"]);
  });

  it("adds mention ids once and removes every matching id", () => {
    expect(toggleUniqueId(["u1"], "u1", true)).toEqual(["u1"]);
    expect(toggleUniqueId(["u1", "u2", "u1"], "u1", false)).toEqual(["u2"]);
  });
});
