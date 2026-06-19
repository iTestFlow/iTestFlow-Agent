import { describe, expect, it } from "vitest";

import type { ExistingTraceabilityRow } from "@/components/workflow/test-intelligence-types";

import {
  cleanTraceabilityLinkText,
  countTraceabilityStatuses,
  coverageTone,
  extractAcceptanceCriteriaReference,
  isTraceabilityLinkHeavy,
  rowSearchText,
  scoreMetricTone,
  truncateTraceabilityText,
} from "./traceability-text";

function makeRow(overrides: Partial<ExistingTraceabilityRow> = {}): ExistingTraceabilityRow {
  return {
    id: "TM-1",
    sourceType: "acceptanceCriteria",
    sourceReference: "AC-1",
    requirementText: "The quote must expire after the configured window.",
    coverageStatus: "Covered",
    severity: "Medium",
    linkedTestCaseIds: [],
    evidenceSummary: "",
    missingCoverage: "",
    recommendedMinimumTestCount: 1,
    recommendedAction: "",
    ...overrides,
  };
}

describe("countTraceabilityStatuses", () => {
  it("returns all zeros for an empty matrix", () => {
    expect(countTraceabilityStatuses([])).toEqual({
      Covered: 0,
      "Partially covered": 0,
      "Not covered": 0,
      "Needs review": 0,
    });
  });

  it("tallies rows by coverage status", () => {
    const rows = [
      makeRow({ id: "TM-1", coverageStatus: "Covered" }),
      makeRow({ id: "TM-2", coverageStatus: "Partially covered" }),
      makeRow({ id: "TM-3", coverageStatus: "Not covered" }),
      makeRow({ id: "TM-4", coverageStatus: "Needs review" }),
      makeRow({ id: "TM-5", coverageStatus: "Not covered" }),
    ];
    const counts = countTraceabilityStatuses(rows);
    expect(counts).toEqual({
      Covered: 1,
      "Partially covered": 1,
      "Not covered": 2,
      "Needs review": 1,
    });
    const gapCount = counts["Partially covered"] + counts["Not covered"] + counts["Needs review"];
    expect(gapCount).toBe(4);
  });
});

describe("scoreMetricTone", () => {
  it("maps scores to tone thresholds", () => {
    expect(scoreMetricTone(80)).toBe("green");
    expect(scoreMetricTone(79)).toBe("yellow");
    expect(scoreMetricTone(60)).toBe("yellow");
    expect(scoreMetricTone(59)).toBe("red");
  });
});

describe("coverageTone", () => {
  it("maps each coverage status to a tone", () => {
    expect(coverageTone("Covered")).toBe("success");
    expect(coverageTone("Partially covered")).toBe("warning");
    expect(coverageTone("Not covered")).toBe("error");
    expect(coverageTone("Needs review")).toBe("draft");
  });
});

describe("extractAcceptanceCriteriaReference", () => {
  it("normalizes AC references to AC-N uppercase", () => {
    expect(extractAcceptanceCriteriaReference("see AC 12 for details")).toBe("AC-12");
    expect(extractAcceptanceCriteriaReference("ac-3")).toBe("AC-3");
  });

  it("returns null when no AC reference is present", () => {
    expect(extractAcceptanceCriteriaReference("Story summary")).toBeNull();
  });
});

describe("cleanTraceabilityLinkText / isTraceabilityLinkHeavy", () => {
  it("reduces a markdown link to its label", () => {
    expect(cleanTraceabilityLinkText("See [the design](https://figma.com/file/abc)")).toBe("See the design");
  });

  it("strips a bare URL from the text", () => {
    expect(cleanTraceabilityLinkText("Open https://example.com/page now")).toBe("Open now");
  });

  it("flags link-heavy text", () => {
    const raw = "https://example.com/very/long/url/that/dominates/the/text";
    expect(isTraceabilityLinkHeavy(raw, cleanTraceabilityLinkText(raw))).toBe(true);
  });

  it("does not flag plain text without links", () => {
    expect(isTraceabilityLinkHeavy("Just a plain requirement.", "Just a plain requirement.")).toBe(false);
  });
});

describe("truncateTraceabilityText", () => {
  it("returns short text unchanged", () => {
    expect(truncateTraceabilityText("short", 10)).toBe("short");
  });

  it("appends an ellipsis when truncating", () => {
    expect(truncateTraceabilityText("abcdefghij", 5)).toBe("abcde...");
  });
});

describe("rowSearchText", () => {
  it("includes id, status, severity, linked ids and action, lowercased", () => {
    const text = rowSearchText(
      makeRow({
        id: "TM-9",
        coverageStatus: "Not covered",
        severity: "High",
        linkedTestCaseIds: ["12345"],
        recommendedAction: "Add a boundary test",
      }),
    );
    expect(text).toContain("tm-9");
    expect(text).toContain("not covered");
    expect(text).toContain("high");
    expect(text).toContain("12345");
    expect(text).toContain("add a boundary test");
  });
});
