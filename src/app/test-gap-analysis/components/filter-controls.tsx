import type { ReactNode } from "react";
import { FilterX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { toneClass } from "@/components/qa/tone";
import { cn } from "@/lib/utils";

/* Shared filter UI primitives for the review sections: the styled native
 * <select>, a toggleable quick-filter chip, and an active-filter summary that
 * surfaces the count and a Clear action. All map onto existing client filters. */

export const filterSelectClass =
  "h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        active ? toneClass.primary : "border-border bg-background text-muted-foreground hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}

export function ActiveFilterSummary({ count, onClear }: { count: number; onClear: () => void }) {
  if (count <= 0) return null;

  return (
    <div className="flex shrink-0 items-center gap-2">
      <span className="text-xs text-muted-foreground">
        {count} filter{count === 1 ? "" : "s"} active
      </span>
      <Button type="button" variant="ghost" size="sm" onClick={onClear}>
        <FilterX />
        Clear filters
      </Button>
    </div>
  );
}
