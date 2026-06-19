import { describe, expect, it } from "vitest";

import type { ExistingReviewFinding, ExistingReviewInsight } from "@/components/workflow/test-intelligence-types";

import {
  EMPTY_FINDINGS_FILTER,
  buildReviewItems,
  deriveCategoryOptions,
  findingsActiveCount,
  findingsFiltersActive,
  matchesFindingsFilter,
  type CoverageReviewItem,
} from "./findings-filters";

function makeFinding(overrides: Partial<ExistingReviewFinding> = {}): ExistingReviewFinding {
  return {
    id: "F-1",
    severity: "Medium",
    category: "Missing coverage",
    title: "Missing boundary test",
    explanation: "The quote expiry boundary is not exercised.",
    relatedMatrixRowIds: ["TM-1"],
    relatedTestCaseIds: ["12345"],
    suggestedAction: "Add a boundary test for the expiry window.",
    ...overrides,
  };
}

function makeInsight(overrides: Partial<ExistingReviewInsight> = {}): ExistingReviewInsight {
  return {
    id: "N-1",
    severity: "Low",
    title: "Consider RTL layout",
    explanation: "Arabic layout edge cases may need attention.",
    relatedMatrixRowIds: [],
    relatedTestCaseIds: [],
    suggestedAction: "Add an RTL smoke test.",
    ...overrides,
  };
}

describe("buildReviewItems", () => {
  it("orders findings before notes, then by severity, then by title", () => {
    const findings = [
      makeFinding({ id: "F-low", severity: "Low", title: "Bravo" }),
      makeFinding({ id: "F-high", severity: "High", title: "Alpha" }),
    ];
    const insights = [makeInsight({ id: "N-high", severity: "High", title: "Note alpha" })];

    const items = buildReviewItems(findings, insights);
    expect(items.map((item) => item.id)).toEqual(["F-high", "F-low", "N-high"]);
    expect(items[0].kind).toBe("finding");
    expect(items[2].kind).toBe("note");
  });

  it("ties on severity are broken alphabetically by title", () => {
    const findings = [
      makeFinding({ id: "F-b", severity: "High", title: "Bravo" }),
      makeFinding({ id: "F-a", severity: "High", title: "Alpha" }),
    ];
    const items = buildReviewItems(findings, []);
    expect(items.map((item) => item.id)).toEqual(["F-a", "F-b"]);
  });

  it("uses the category as the finding label and leaves notes without one", () => {
    const items = buildReviewItems([makeFinding({ category: "Weak expected result" })], [makeInsight()]);
    const finding = items.find((item) => item.kind === "finding");
    const note = items.find((item) => item.kind === "note");
    expect(finding?.label).toBe("Weak expected result");
    expect(note?.label).toBeUndefined();
  });

  it("defaults missing related id arrays to empty arrays", () => {
    const finding = makeFinding({ relatedMatrixRowIds: undefined, relatedTestCaseIds: undefined });
    const [item] = buildReviewItems([finding], []);
    expect(item.relatedMatrixRowIds).toEqual([]);
    expect(item.relatedTestCaseIds).toEqual([]);
  });
});

describe("deriveCategoryOptions", () => {
  it("dedupes and sorts categories with All prepended and falsy values filtered", () => {
    const findings = [
      makeFinding({ category: "Weak expected result" }),
      makeFinding({ category: "Missing coverage" }),
      makeFinding({ category: "Missing coverage" }),
      makeFinding({ category: "" }),
    ];
    expect(deriveCategoryOptions(findings)).toEqual(["All", "Missing coverage", "Weak expected result"]);
  });
});

describe("matchesFindingsFilter", () => {
  const item: CoverageReviewItem = {
    kind: "finding",
    id: "F-1",
    severity: "High",
    label: "Missing coverage",
    title: "Missing boundary test",
    explanation: "The quote expiry boundary is not exercised.",
    relatedMatrixRowIds: ["TM-1"],
    relatedTestCaseIds: ["12345"],
    suggestedAction: "Add a boundary test.",
  };

  it("passes when all filters are at their defaults", () => {
    expect(matchesFindingsFilter(item, EMPTY_FINDINGS_FILTER)).toBe(true);
  });

  it("filters by item kind", () => {
    expect(matchesFindingsFilter(item, { ...EMPTY_FINDINGS_FILTER, itemKind: "note" })).toBe(false);
    expect(matchesFindingsFilter(item, { ...EMPTY_FINDINGS_FILTER, itemKind: "finding" })).toBe(true);
  });

  it("filters by severity", () => {
    expect(matchesFindingsFilter(item, { ...EMPTY_FINDINGS_FILTER, severity: "Low" })).toBe(false);
    expect(matchesFindingsFilter(item, { ...EMPTY_FINDINGS_FILTER, severity: "High" })).toBe(true);
  });

  it("filters by category", () => {
    expect(matchesFindingsFilter(item, { ...EMPTY_FINDINGS_FILTER, category: "Duplicate" })).toBe(false);
    expect(matchesFindingsFilter(item, { ...EMPTY_FINDINGS_FILTER, category: "Missing coverage" })).toBe(true);
  });

  it("filters by related test-case state", () => {
    expect(matchesFindingsFilter(item, { ...EMPTY_FINDINGS_FILTER, related: "No test cases" })).toBe(false);
    const withoutCases: CoverageReviewItem = { ...item, relatedTestCaseIds: [] };
    expect(matchesFindingsFilter(withoutCases, { ...EMPTY_FINDINGS_FILTER, related: "No test cases" })).toBe(true);
  });

  it("searches across title, explanation and ids (case-insensitive)", () => {
    expect(matchesFindingsFilter(item, { ...EMPTY_FINDINGS_FILTER, search: "BOUNDARY" })).toBe(true);
    expect(matchesFindingsFilter(item, { ...EMPTY_FINDINGS_FILTER, search: "12345" })).toBe(true);
    expect(matchesFindingsFilter(item, { ...EMPTY_FINDINGS_FILTER, search: "nonexistent" })).toBe(false);
  });
});

describe("findingsFiltersActive / findingsActiveCount", () => {
  it("reports inactive defaults", () => {
    expect(findingsFiltersActive(EMPTY_FINDINGS_FILTER)).toBe(false);
    expect(findingsActiveCount(EMPTY_FINDINGS_FILTER)).toBe(0);
  });

  it("counts each non-default dimension", () => {
    const state = { search: "x", itemKind: "finding" as const, severity: "High" as const, category: "Missing coverage", related: "No test cases" as const };
    expect(findingsFiltersActive(state)).toBe(true);
    expect(findingsActiveCount(state)).toBe(5);
  });
});
