"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, Sparkles } from "lucide-react";

import { SectionCard } from "@/components/workflow/test-intelligence-shared";

import { splitSummaryKeyPoints } from "../lib/summary-key-points";

/* Review summary presented as scannable key points. The first few points are
 * shown by default; the rest collapse behind "Show more". Plain-text summaries
 * that cannot be split fall back to a clamped paragraph with the same toggle. */

const DEFAULT_VISIBLE_POINTS = 3;

export function ReviewSummaryCard({ summary }: { summary: string }) {
  const parsed = useMemo(() => splitSummaryKeyPoints(summary), [summary]);
  const [expanded, setExpanded] = useState(false);

  const isPoints = parsed.kind === "points";
  const hiddenCount = isPoints ? Math.max(parsed.points.length - DEFAULT_VISIBLE_POINTS, 0) : 0;
  const visiblePoints = isPoints
    ? expanded
      ? parsed.points
      : parsed.points.slice(0, DEFAULT_VISIBLE_POINTS)
    : [];
  const canToggle = isPoints ? hiddenCount > 0 : parsed.text.length > 220;

  return (
    <SectionCard>
      <div className="p-4">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-foreground">Review Summary</h3>
        </div>

        {isPoints ? (
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {visiblePoints.map((point, index) => (
              <li key={`${index}-${point.slice(0, 24)}`} className="flex gap-2 text-sm leading-6 text-muted-foreground">
                <CheckCircle2 className="mt-1 size-4 shrink-0 text-primary" aria-hidden="true" />
                <span>{point}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className={`mt-2 text-sm leading-6 text-muted-foreground ${expanded ? "" : "line-clamp-3"}`}>{parsed.text}</p>
        )}

        {canToggle ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            className="mt-3 inline-flex items-center text-xs font-medium text-primary outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {expanded ? "Show less" : isPoints ? `Show ${hiddenCount} more` : "Show full summary"}
          </button>
        ) : null}
      </div>
    </SectionCard>
  );
}
