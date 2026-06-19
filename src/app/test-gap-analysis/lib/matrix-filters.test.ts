import { describe, expect, it } from "vitest";

import type { ExistingTraceabilityRow } from "@/components/workflow/test-intelligence-types";

import {
  EMPTY_MATRIX_FILTER,
  matchesMatrixFilter,
  matrixActiveCount,
  matrixFiltersActive,
} from "./matrix-filters";

function makeRow(overrides: Partial<ExistingTraceabilityRow> = {}): ExistingTraceabilityRow {
  return {
    id: "TM-1",
    sourceType: "acceptanceCriteria",
    sourceReference: "AC-1",
    requirementText: "The quote must expire after the configured window.",
    coverageStatus: "Not covered",
    severity: "High",
    linkedTestCaseIds: ["12345"],
    evidenceSummary: "",
    missingCoverage: "No expiry boundary test exists.",
    recommendedMinimumTestCount: 2,
    recommendedAction: "Add a boundary test.",
    ...overrides,
  };
}

describe("matchesMatrixFilter", () => {
  it("passes when all filters are at their defaults", () => {
    expect(matchesMatrixFilter(makeRow(), EMPTY_MATRIX_FILTER)).toBe(true);
  });

  it("gapsOnly excludes Covered rows", () => {
    const covered = makeRow({ coverageStatus: "Covered" });
    expect(matchesMatrixFilter(covered, { ...EMPTY_MATRIX_FILTER, gapsOnly: true })).toBe(false);
    expect(matchesMatrixFilter(makeRow(), { ...EMPTY_MATRIX_FILTER, gapsOnly: true })).toBe(true);
  });

  it("filters by coverage status", () => {
    expect(matchesMatrixFilter(makeRow(), { ...EMPTY_MATRIX_FILTER, coverage: "Covered" })).toBe(false);
    expect(matchesMatrixFilter(makeRow(), { ...EMPTY_MATRIX_FILTER, coverage: "Not covered" })).toBe(true);
  });

  it("filters by severity and source", () => {
    expect(matchesMatrixFilter(makeRow(), { ...EMPTY_MATRIX_FILTER, severity: "Low" })).toBe(false);
    expect(matchesMatrixFilter(makeRow(), { ...EMPTY_MATRIX_FILTER, source: "story" })).toBe(false);
    expect(matchesMatrixFilter(makeRow(), { ...EMPTY_MATRIX_FILTER, source: "acceptanceCriteria" })).toBe(true);
  });

  it("filters by linked test-case state", () => {
    expect(matchesMatrixFilter(makeRow(), { ...EMPTY_MATRIX_FILTER, linkState: "No linked test cases" })).toBe(false);
    const unlinked = makeRow({ linkedTestCaseIds: [] });
    expect(matchesMatrixFilter(unlinked, { ...EMPTY_MATRIX_FILTER, linkState: "No linked test cases" })).toBe(true);
    expect(matchesMatrixFilter(makeRow(), { ...EMPTY_MATRIX_FILTER, linkState: "Has linked test cases" })).toBe(true);
  });

  it("searches row text case-insensitively", () => {
    expect(matchesMatrixFilter(makeRow(), { ...EMPTY_MATRIX_FILTER, search: "BOUNDARY" })).toBe(true);
    expect(matchesMatrixFilter(makeRow(), { ...EMPTY_MATRIX_FILTER, search: "nonexistent" })).toBe(false);
  });
});

describe("matrixFiltersActive / matrixActiveCount", () => {
  it("reports inactive defaults", () => {
    expect(matrixFiltersActive(EMPTY_MATRIX_FILTER)).toBe(false);
    expect(matrixActiveCount(EMPTY_MATRIX_FILTER)).toBe(0);
  });

  it("counts each non-default dimension", () => {
    const state = {
      search: "x",
      coverage: "Not covered" as const,
      severity: "High" as const,
      source: "story" as const,
      linkState: "No linked test cases" as const,
      gapsOnly: true,
    };
    expect(matrixFiltersActive(state)).toBe(true);
    expect(matrixActiveCount(state)).toBe(6);
  });
});
