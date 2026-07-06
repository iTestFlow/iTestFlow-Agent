import type { RequirementFinding } from "@/components/workflow/test-intelligence-types";

import { severityRank } from "./comment-helpers";

export function sortFindingsBySeverity(findings: readonly RequirementFinding[]) {
  return [...findings].sort(
    (left, right) => severityRank(left.severity) - severityRank(right.severity),
  );
}

export function selectFindings(
  findings: readonly RequirementFinding[],
  selectedIds: readonly string[],
) {
  const selected = new Set(selectedIds);
  return findings.filter((finding) => selected.has(finding.id));
}

export function countInvalidFindings(
  findings: readonly RequirementFinding[],
  validate: (finding: RequirementFinding) => { valid: boolean },
) {
  return findings.filter((finding) => !validate(finding).valid).length;
}

export function toggleOrderedSelection<T extends string>(
  orderedIds: readonly T[],
  selectedIds: readonly T[],
  id: T,
  checked: boolean,
) {
  const next = new Set(selectedIds);
  if (checked) next.add(id);
  else next.delete(id);
  return orderedIds.filter((candidate) => next.has(candidate));
}

export function toggleUniqueId(
  selectedIds: readonly string[],
  id: string,
  selected: boolean,
) {
  if (!selected) return selectedIds.filter((candidate) => candidate !== id);
  return selectedIds.includes(id) ? [...selectedIds] : [...selectedIds, id];
}
