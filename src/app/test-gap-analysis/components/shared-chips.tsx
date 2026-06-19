import type { Tone } from "@/components/qa/tone";
import { ToneBadge } from "@/components/workflow/test-intelligence-shared";

/* Shared chip rows used by both the Findings Review Queue and the Traceability
 * Matrix to render related matrix-row IDs and linked test-case IDs. */

export function RelatedIdChips({ label, ids, tone = "primary" }: { label?: string; ids: string[]; tone?: Tone }) {
  if (!ids.length) return null;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {label ? <span className="mr-1 text-xs font-medium text-muted-foreground">{label}</span> : null}
      {ids.map((id) => (
        <ToneBadge key={id} tone={tone}>{id}</ToneBadge>
      ))}
    </div>
  );
}

export function TestCaseChips({ ids, max }: { ids: string[]; max?: number }) {
  if (!ids.length) return <span className="text-xs text-muted-foreground">No linked test cases</span>;

  const visibleIds = typeof max === "number" ? ids.slice(0, max) : ids;
  const hiddenCount = ids.length - visibleIds.length;

  return (
    <div className="flex flex-wrap gap-1">
      {visibleIds.map((id) => (
        <span key={id} aria-label={`Linked test case ${id}`}>
          <ToneBadge tone="primary" className="font-mono">{id}</ToneBadge>
        </span>
      ))}
      {hiddenCount > 0 ? <ToneBadge tone="neutral">+{hiddenCount}</ToneBadge> : null}
    </div>
  );
}
