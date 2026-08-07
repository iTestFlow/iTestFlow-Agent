"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Eye,
  Minus,
  ShieldAlert,
  SkipForward,
  Slash,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Outcome rendering is never color-only: icon + label + tone, one shared
 * component for step, case, and run outcomes (a11y rule from the plan).
 */

const OUTCOME_PRESENTATION: Record<string, { label: string; icon: LucideIcon; className: string }> = {
  passed: { label: "Passed", icon: CheckCircle2, className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 border-transparent" },
  failed: { label: "Failed", icon: XCircle, className: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300 border-transparent" },
  failed_assertion: { label: "Failed assertion", icon: XCircle, className: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300 border-transparent" },
  blocked: { label: "Blocked", icon: ShieldAlert, className: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300 border-transparent" },
  blocked_policy: { label: "Blocked by policy", icon: ShieldAlert, className: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300 border-transparent" },
  blocked_prerequisite: { label: "Blocked by prerequisite", icon: ShieldAlert, className: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300 border-transparent" },
  infrastructure_error: { label: "Infrastructure error", icon: AlertTriangle, className: "bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-300 border-transparent" },
  timeout: { label: "Timeout", icon: Clock, className: "bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-300 border-transparent" },
  canceled: { label: "Canceled", icon: Slash, className: "bg-muted text-muted-foreground border-transparent" },
  skipped: { label: "Skipped", icon: SkipForward, className: "bg-muted text-muted-foreground border-transparent" },
  not_run: { label: "Not run", icon: Minus, className: "bg-muted text-muted-foreground border-transparent" },
  needs_review: { label: "Needs review", icon: Eye, className: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-300 border-transparent" },
};

export function OutcomeBadge({ outcome, className }: { outcome: string | null | undefined; className?: string }) {
  if (!outcome) return null;
  const presentation = OUTCOME_PRESENTATION[outcome] ?? {
    label: outcome.replace(/_/g, " "),
    icon: Minus,
    className: "bg-muted text-muted-foreground border-transparent",
  };
  const Icon = presentation.icon;
  return (
    <Badge className={cn("gap-1 font-medium", presentation.className, className)}>
      <Icon aria-hidden className="h-3.5 w-3.5" />
      {presentation.label}
    </Badge>
  );
}
