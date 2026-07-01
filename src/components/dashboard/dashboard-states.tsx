import { BarChart3, SearchX, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function DashboardLoadingState({
  label = "Loading dashboard data",
  cards = 6,
  className,
}: {
  label?: string;
  cards?: number;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      className={cn("space-y-4", className)}
    >
      <span className="sr-only">{label}</span>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: cards }).map((_, index) => (
          <div key={index} className="content-surface space-y-4 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 space-y-3">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-8 w-20" />
              </div>
              <Skeleton className="size-9 rounded-lg" />
            </div>
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-3/4" />
          </div>
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="content-surface space-y-4 p-4">
          <Skeleton className="h-4 w-44" />
          <Skeleton className="h-[220px] w-full" />
        </div>
        <div className="content-surface space-y-4 p-4">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-[220px] w-full" />
        </div>
      </div>
    </div>
  );
}

export function DashboardEmptyPanel({
  title = "No data for this view",
  message,
  compact = false,
  className,
  icon,
  actionLabel,
  onAction,
  live = true,
}: {
  title?: string;
  message: string;
  compact?: boolean;
  className?: string;
  icon?: LucideIcon;
  actionLabel?: string;
  onAction?: () => void;
  /** When true, announces politely (role="status"). Set false for purely static empties. */
  live?: boolean;
}) {
  const Icon = icon ?? (compact ? SearchX : BarChart3);

  return (
    <div
      role={live ? "status" : undefined}
      className={cn(
        "content-empty-state",
        compact ? "min-h-32 py-6" : "min-h-[220px] py-8",
        className,
      )}
    >
      <div className="rounded-lg border border-border bg-background p-2.5 text-muted-foreground shadow-sm">
        <Icon className="size-5" aria-hidden="true" />
      </div>
      <div className="space-y-1">
        <div className="font-semibold text-foreground">{title}</div>
        <p className="mx-auto max-w-md text-sm leading-6 text-muted-foreground">{message}</p>
      </div>
      {actionLabel && onAction ? (
        <Button type="button" variant="outline" size="sm" onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}
