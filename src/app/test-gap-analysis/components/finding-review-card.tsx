"use client";

import { useId, useState } from "react";
import { ChevronDown, Eye } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ToneBadge, severityTone } from "@/components/workflow/test-intelligence-shared";
import { cn } from "@/lib/utils";

import type { CoverageReviewItem } from "../lib/findings-filters";
import { RelatedIdChips } from "./shared-chips";

/* A single finding/note rendered as a compact review-queue card. Collapsed it
 * shows only severity/type badges, title, a one-line issue summary, a
 * highlighted recommended action (max 2 lines), related counts, and the actions.
 * The full explanation and complete related-ID lists move behind "Details".
 *
 * Self-managed expand state keeps the card layout fully under our control and
 * lets "View affected rows" stay an independent, focusable button (it is not
 * nested inside the expand control). */

export function FindingReviewCard({
  item,
  onViewAffectedRows,
}: {
  item: CoverageReviewItem;
  onViewAffectedRows: (rowIds: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const matrixCount = item.relatedMatrixRowIds.length;
  const testCaseCount = item.relatedTestCaseIds.length;

  return (
    <div className={cn("rounded-lg border border-border bg-card transition-colors", open && "border-primary/40")}>
      <div className="p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <ToneBadge tone={severityTone(item.severity)}>{item.severity}</ToneBadge>
            <ToneBadge tone={item.kind === "finding" ? "warning" : "neutral"}>
              {item.kind === "finding" ? "Finding" : "Note"}
            </ToneBadge>
            {item.label ? <ToneBadge tone="neutral">{item.label}</ToneBadge> : null}
          </div>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen((value) => !value)}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {open ? "Less" : "Details"}
            <ChevronDown className={cn("size-4 transition-transform duration-200", open && "rotate-180")} aria-hidden="true" />
          </button>
        </div>

        <h4 className="mt-1.5 line-clamp-1 text-sm font-semibold text-foreground">{item.title}</h4>
        {!open ? (
          <p className="mt-0.5 line-clamp-1 text-xs leading-5 text-muted-foreground">{item.explanation}</p>
        ) : null}

        <div className="mt-2 rounded-md border border-l-2 border-primary/40 border-l-primary/60 bg-primary/5 px-2.5 py-1.5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Recommended action</div>
          <p className={cn("mt-0.5 text-xs leading-5 text-primary", !open && "line-clamp-2")}>{item.suggestedAction}</p>
        </div>

        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{matrixCount} matrix row{matrixCount === 1 ? "" : "s"}</span>
            <span aria-hidden="true">·</span>
            <span>{testCaseCount} linked case{testCaseCount === 1 ? "" : "s"}</span>
          </div>
          {matrixCount ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => onViewAffectedRows(item.relatedMatrixRowIds)}
            >
              <Eye className="size-3.5" />
              View affected rows
            </Button>
          ) : null}
        </div>
      </div>

      {open ? (
        <div id={detailsId} className="space-y-3 border-t border-border bg-muted/10 p-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Full explanation</div>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{item.explanation}</p>
          </div>
          {matrixCount || testCaseCount ? (
            <div className="flex flex-col gap-2">
              <RelatedIdChips label="Matrix rows" ids={item.relatedMatrixRowIds} tone="primary" />
              <RelatedIdChips label="Linked cases" ids={item.relatedTestCaseIds} tone="neutral" />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
