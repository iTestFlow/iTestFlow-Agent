import { ListChecks } from "lucide-react";

import { Button } from "@/components/ui/button";
import { StickyActionBar } from "@/components/workflow/sticky-action-bar";

/* Sticky bottom bar for the review step. Surfaces a compact review state and
 * keeps the final CTA visible while scrolling. The CTA behaviour is identical
 * to the previous inline "Review linked cases and additions" button. */

export function StickyReviewActionBar({
  findingCount,
  gapCount,
  recommendationCount,
  onReview,
}: {
  findingCount: number;
  gapCount: number;
  recommendationCount: number;
  onReview: () => void;
}) {
  return (
    <StickyActionBar
      title={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>{findingCount} finding{findingCount === 1 ? "" : "s"}</span>
          <span aria-hidden="true" className="text-muted-foreground">·</span>
          <span>{gapCount} gap{gapCount === 1 ? "" : "s"}</span>
          <span aria-hidden="true" className="text-muted-foreground">·</span>
          <span>{recommendationCount} recommendation{recommendationCount === 1 ? "" : "s"} ready</span>
        </span>
      }
      description="Review linked Azure DevOps test cases and approve suggested additions."
      actions={
        <Button type="button" size="lg" onClick={onReview}>
          <ListChecks className="size-4" />
          Review linked cases and additions
        </Button>
      }
    />
  );
}
