import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function StickyActionBar({
  title,
  description,
  actions,
  className,
  actionsClassName,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions: ReactNode;
  className?: string;
  actionsClassName?: string;
}) {
  return (
    <div
      className={cn(
        "sticky bottom-3 z-20 rounded-xl border border-border bg-card/95 p-3 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-card/90",
        className,
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          {title ? <div className="text-sm font-semibold text-foreground">{title}</div> : null}
          {description ? <div className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</div> : null}
        </div>
        <div className={cn("flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center", actionsClassName)}>
          {actions}
        </div>
      </div>
    </div>
  );
}
