import type {
  ExistingTraceabilityRow,
  GeneratedTestCase,
} from "@/components/workflow/test-intelligence-types";

export function selectSuggestedAdditions(
  suggestions: readonly GeneratedTestCase[],
  selectedIds: readonly string[],
) {
  const selected = new Set(selectedIds);
  return suggestions.filter((suggestion) => selected.has(suggestion.id));
}

export function countInvalidSuggestions(
  suggestions: readonly GeneratedTestCase[],
  validate: (suggestion: GeneratedTestCase) => { valid: boolean },
) {
  return suggestions.filter((suggestion) => !validate(suggestion).valid).length;
}

export function countReviewGaps(rows: readonly ExistingTraceabilityRow[]) {
  return rows.filter((row) => row.coverageStatus !== "Covered").length;
}
