import type { ExistingReviewFinding, ExistingReviewInsight } from "@/components/workflow/test-intelligence-types";

import type { SeverityFilter } from "./matrix-filters";

/* --------------------------------------------------------------------------
 * Pure client-side filter model for the Findings Review Queue. Findings and
 * insights ("notes") are merged into a single sortable/filterable item type.
 * No backend filtering — operates on data already in component state.
 * ------------------------------------------------------------------------ */

export type CoverageReviewItem =
  | {
      kind: "finding";
      id: string;
      severity: ExistingReviewFinding["severity"];
      label?: string;
      title: string;
      explanation: string;
      relatedMatrixRowIds: string[];
      relatedTestCaseIds: string[];
      suggestedAction: string;
    }
  | {
      kind: "note";
      id: string;
      severity: ExistingReviewInsight["severity"];
      label?: string;
      title: string;
      explanation: string;
      relatedMatrixRowIds: string[];
      relatedTestCaseIds: string[];
      suggestedAction: string;
    };

export type CoverageItemKindFilter = "All" | CoverageReviewItem["kind"];
export type CoverageItemCategoryFilter = "All" | string;
export type CoverageItemRelatedFilter = "All" | "Has matrix rows" | "No matrix rows" | "Has test cases" | "No test cases";

export type FindingsFilterState = {
  search: string;
  itemKind: CoverageItemKindFilter;
  severity: SeverityFilter;
  category: CoverageItemCategoryFilter;
  related: CoverageItemRelatedFilter;
};

export const EMPTY_FINDINGS_FILTER: FindingsFilterState = {
  search: "",
  itemKind: "All",
  severity: "All",
  category: "All",
  related: "All",
};

const severitySortOrder: Record<ExistingReviewFinding["severity"], number> = { High: 0, Medium: 1, Low: 2 };
const reviewItemKindSortOrder: Record<CoverageReviewItem["kind"], number> = { finding: 0, note: 1 };

export const coverageItemKindFilterOptions: CoverageItemKindFilter[] = ["All", "finding", "note"];
export const coverageItemRelatedFilterOptions: CoverageItemRelatedFilter[] = [
  "All",
  "Has matrix rows",
  "No matrix rows",
  "Has test cases",
  "No test cases",
];

export function buildReviewItems(
  findings: ExistingReviewFinding[],
  insights: ExistingReviewInsight[],
): CoverageReviewItem[] {
  return [
    ...findings.map((finding): CoverageReviewItem => ({
      kind: "finding",
      id: finding.id,
      severity: finding.severity,
      label: finding.category,
      title: finding.title,
      explanation: finding.explanation,
      relatedMatrixRowIds: finding.relatedMatrixRowIds ?? [],
      relatedTestCaseIds: finding.relatedTestCaseIds ?? [],
      suggestedAction: finding.suggestedAction,
    })),
    ...insights.map((insight): CoverageReviewItem => ({
      kind: "note",
      id: insight.id,
      severity: insight.severity,
      title: insight.title,
      explanation: insight.explanation,
      relatedMatrixRowIds: insight.relatedMatrixRowIds,
      relatedTestCaseIds: insight.relatedTestCaseIds,
      suggestedAction: insight.suggestedAction,
    })),
  ].sort((a, b) =>
    reviewItemKindSortOrder[a.kind] - reviewItemKindSortOrder[b.kind]
    || severitySortOrder[a.severity] - severitySortOrder[b.severity]
    || a.title.localeCompare(b.title),
  );
}

export function deriveCategoryOptions(findings: ExistingReviewFinding[]): string[] {
  return ["All", ...new Set(findings.map((finding) => finding.category).filter(Boolean).sort())];
}

export function matchesFindingsFilter(item: CoverageReviewItem, state: FindingsFilterState): boolean {
  if (state.itemKind !== "All" && item.kind !== state.itemKind) return false;
  if (state.severity !== "All" && item.severity !== state.severity) return false;
  if (state.category !== "All" && item.label !== state.category) return false;
  if (state.related === "Has matrix rows" && !item.relatedMatrixRowIds.length) return false;
  if (state.related === "No matrix rows" && item.relatedMatrixRowIds.length) return false;
  if (state.related === "Has test cases" && !item.relatedTestCaseIds.length) return false;
  if (state.related === "No test cases" && item.relatedTestCaseIds.length) return false;
  const searchTerm = state.search.trim().toLowerCase();
  if (!searchTerm) return true;
  return coverageReviewItemSearchText(item).includes(searchTerm);
}

export function findingsFiltersActive(state: FindingsFilterState): boolean {
  return Boolean(state.search.trim())
    || state.itemKind !== "All"
    || state.severity !== "All"
    || state.category !== "All"
    || state.related !== "All";
}

export function findingsActiveCount(state: FindingsFilterState): number {
  let count = 0;
  if (state.search.trim()) count += 1;
  if (state.itemKind !== "All") count += 1;
  if (state.severity !== "All") count += 1;
  if (state.category !== "All") count += 1;
  if (state.related !== "All") count += 1;
  return count;
}

export function formatCoverageItemKindFilterLabel(option: CoverageItemKindFilter) {
  if (option === "All") return "All items";
  if (option === "finding") return "Findings";
  return "Notes";
}

export function formatCoverageItemRelatedFilterLabel(option: CoverageItemRelatedFilter) {
  return option === "All" ? "All related" : option;
}

export function coverageReviewItemSearchText(item: CoverageReviewItem) {
  return [
    item.id,
    item.kind,
    item.kind === "finding" ? "Finding" : "Note",
    item.severity,
    item.label,
    item.title,
    item.explanation,
    item.suggestedAction,
    item.relatedMatrixRowIds.join(" "),
    item.relatedTestCaseIds.join(" "),
  ].filter(Boolean).join(" ").toLowerCase();
}
