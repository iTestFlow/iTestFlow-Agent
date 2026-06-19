import type { ExistingTraceabilityRow } from "@/components/workflow/test-intelligence-types";

import { coverageSourceLabel, rowSearchText } from "./traceability-text";

/* --------------------------------------------------------------------------
 * Pure client-side filter model for the Traceability Matrix. All predicates
 * operate on data already loaded in component state — no backend filtering.
 * ------------------------------------------------------------------------ */

export type CoverageFilter = ExistingTraceabilityRow["coverageStatus"] | "All";
export type SeverityFilter = ExistingTraceabilityRow["severity"] | "All";
export type SourceFilter = ExistingTraceabilityRow["sourceType"] | "All";
export type LinkStateFilter = "All" | "Has linked test cases" | "No linked test cases";

export type MatrixFilterState = {
  search: string;
  coverage: CoverageFilter;
  severity: SeverityFilter;
  source: SourceFilter;
  linkState: LinkStateFilter;
  gapsOnly: boolean;
};

export const EMPTY_MATRIX_FILTER: MatrixFilterState = {
  search: "",
  coverage: "All",
  severity: "All",
  source: "All",
  linkState: "All",
  gapsOnly: false,
};

export const coverageFilterOptions: CoverageFilter[] = ["All", "Covered", "Partially covered", "Not covered", "Needs review"];
export const severityFilterOptions: SeverityFilter[] = ["All", "High", "Medium", "Low"];
export const sourceFilterOptions: SourceFilter[] = ["All", "story", "description", "acceptanceCriteria", "businessRules"];
export const linkStateFilterOptions: LinkStateFilter[] = ["All", "Has linked test cases", "No linked test cases"];

export function matchesMatrixFilter(row: ExistingTraceabilityRow, state: MatrixFilterState): boolean {
  if (state.gapsOnly && row.coverageStatus === "Covered") return false;
  if (state.coverage !== "All" && row.coverageStatus !== state.coverage) return false;
  if (state.severity !== "All" && row.severity !== state.severity) return false;
  if (state.source !== "All" && row.sourceType !== state.source) return false;
  if (state.linkState === "Has linked test cases" && !row.linkedTestCaseIds.length) return false;
  if (state.linkState === "No linked test cases" && row.linkedTestCaseIds.length) return false;
  const searchTerm = state.search.trim().toLowerCase();
  if (!searchTerm) return true;
  return rowSearchText(row).includes(searchTerm);
}

export function matrixFiltersActive(state: MatrixFilterState): boolean {
  return Boolean(state.search.trim())
    || state.coverage !== "All"
    || state.severity !== "All"
    || state.source !== "All"
    || state.linkState !== "All"
    || state.gapsOnly;
}

export function matrixActiveCount(state: MatrixFilterState): number {
  let count = 0;
  if (state.search.trim()) count += 1;
  if (state.coverage !== "All") count += 1;
  if (state.severity !== "All") count += 1;
  if (state.source !== "All") count += 1;
  if (state.linkState !== "All") count += 1;
  if (state.gapsOnly) count += 1;
  return count;
}

export function formatCoverageFilterLabel(option: CoverageFilter) {
  return option === "All" ? "All coverage" : option;
}

export function formatSourceFilterLabel(option: SourceFilter) {
  return option === "All" ? "All sources" : coverageSourceLabel(option);
}
