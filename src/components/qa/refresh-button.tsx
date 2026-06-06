"use client";

import { Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function RefreshButton({
  loading = false,
  disabled = false,
  label = "Refresh",
  className,
  onClick,
}: {
  loading?: boolean;
  disabled?: boolean;
  label?: string;
  className?: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      className={cn("h-8 shrink-0 whitespace-nowrap", className)}
      disabled={disabled || loading}
      onClick={onClick}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="size-4" aria-hidden="true" />}
      {label}
    </Button>
  );
}
