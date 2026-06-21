"use client";

import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  Bug,
  CheckCircle2,
  CircleHelp,
  ClipboardCheck,
  Gauge,
  ShieldAlert,
  TestTube2,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type {
  DashboardAnalytics,
  DashboardMetric,
  DashboardReadinessStatus,
  DashboardTab,
} from "@/types/dashboard";

export function DashboardKpiGrid({
  data,
  loading,
  onNavigate,
}: {
  data?: DashboardAnalytics;
  loading: boolean;
  onNavigate: (target: DashboardTab | "readiness") => void;
}) {
  if (!data && loading) {
    return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-[138px] rounded-xl" />)}</div>;
  }
  if (!data) return null;
  const kpis = data.kpis;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <MetricKpi label="Test Execution Progress" metric={kpis.testExecutionProgress} icon={TestTube2} format="percentage" help="Executed test points divided by all selected Azure Test Plan points. Skipped/N/A counts as executed." onClick={() => onNavigate("testing")} />
      <MetricKpi label="Pass Rate" metric={kpis.passRate} icon={CheckCircle2} format="percentage" help="Passed outcomes divided by passed, failed, and blocked outcomes. Skipped/N/A is excluded." onClick={() => onNavigate("testing")} />
      <MetricKpi label="Requirements Coverage" metric={kpis.requirementsCoverage} icon={ClipboardCheck} format="percentage" help="Requirements with at least one linked Azure Test Case divided by all requirements in scope." onClick={() => onNavigate("blockers")} />
      <MetricKpi label="Open Critical / High" metric={kpis.openCriticalHighBugs} icon={ShieldAlert} alert={Boolean(kpis.openCriticalHighBugs.value)} onClick={() => onNavigate("bugs")} />
      <MetricKpi label="Open Bugs" metric={kpis.openBugs} icon={Bug} onClick={() => onNavigate("bugs")} />
    </div>
  );
}

export function ReleaseReadinessCard({ data }: { data: DashboardAnalytics["releaseReadiness"] }) {
  const config = readinessConfig(data.status);
  const Icon = config.icon;
  // The headline is reasons[0]; surface the next breached gates as chips so high/critical
  // bugs and other secondary risks are never buried beneath the single primary reason.
  const moreReasons = data.reasons.slice(1, 4);
  return (
    <Card id="release-readiness" className={cn("qa-card scroll-mt-20 overflow-hidden border-l-4", config.border)}>
      <CardContent className="grid gap-5 p-5 lg:grid-cols-[250px_1fr] lg:items-center">
        <div className="flex items-center gap-4">
          <div className={cn("rounded-xl border p-3", config.surface)}><Icon className="size-6" /></div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Release Decision</div>
            <div className="mt-1 text-2xl font-bold text-foreground">{config.label}</div>
          </div>
        </div>
        <div className="border-t border-border/70 pt-4 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
          <div className="text-xs font-medium uppercase tracking-normal text-muted-foreground">Primary reason</div>
          <p className="mt-1 text-base font-semibold leading-6 text-foreground">{sentenceCase(data.reasons[0] ?? data.summary)}</p>
          {moreReasons.length ? (
            <div className="mt-3">
              <div className="text-[11px] font-medium uppercase tracking-normal text-muted-foreground">Also flagging</div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {moreReasons.map((reason) => (
                  <span key={reason} className={cn("inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium leading-5", reasonChipTone(reason))}>
                    {capitalizeReason(reason)}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function capitalizeReason(value: string) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function reasonChipTone(reason: string) {
  const normalized = reason.toLowerCase();
  return normalized.includes("critical bug") || normalized.includes("high severity")
    ? "border-destructive/30 bg-destructive/10 text-destructive"
    : "border-warning/35 bg-warning/10 text-foreground";
}

function MetricKpi({
  label,
  metric,
  icon: Icon,
  format = "number",
  alert,
  help,
  onClick,
}: {
  label: string;
  metric: DashboardMetric;
  icon: LucideIcon;
  format?: "number" | "percentage";
  alert?: boolean;
  help?: string;
  onClick: () => void;
}) {
  const display = metric.available && metric.value !== null ? `${metric.value}${format === "percentage" ? "%" : ""}` : "Unknown";
  return (
    <KpiSurface label={`View ${label}`} onClick={onClick}>
      <Card className={cn("qa-card h-full", alert && "border-destructive/30")}>
        <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
          <div className="flex items-center gap-1.5">
            <CardTitle className="text-xs font-medium uppercase tracking-normal text-muted-foreground">{label}</CardTitle>
            {help ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" aria-label={`About ${label}`} onClick={(event) => event.stopPropagation()}><CircleHelp className="size-3.5 text-muted-foreground" /></button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">{help}</TooltipContent>
              </Tooltip>
            ) : null}
          </div>
          <Icon className={cn("size-4", alert ? "text-destructive" : "text-primary")} />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold text-foreground">{display}</div>
          {format === "percentage" && metric.percentage !== null && metric.percentage !== undefined ? <Progress value={metric.percentage} className="mt-3 h-1.5" /> : null}
          <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">{metric.supportingText}</p>
        </CardContent>
      </Card>
    </KpiSurface>
  );
}

function KpiSurface({
  onClick,
  label,
  children,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      className="h-full cursor-pointer rounded-xl transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
    >
      {children}
    </div>
  );
}

function sentenceCase(value: string) {
  if (!value) return value;
  const sentence = value.charAt(0).toUpperCase() + value.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

function readinessConfig(status: DashboardReadinessStatus) {
  if (status === "ready") return { label: "Ready", tone: "success" as const, icon: CheckCircle2, border: "border-success/40", surface: "border-success/30 bg-success/10 text-success", text: "text-success" };
  if (status === "at_risk") return { label: "Ready with Risk", tone: "warning" as const, icon: AlertTriangle, border: "border-warning/50", surface: "border-warning/40 bg-warning/15 text-warning-foreground dark:text-warning", text: "text-warning" };
  if (status === "not_ready") return { label: "Not Ready", tone: "error" as const, icon: ShieldAlert, border: "border-destructive/50", surface: "border-destructive/30 bg-destructive/10 text-destructive", text: "text-destructive" };
  return { label: "Unknown", tone: "neutral" as const, icon: Gauge, border: "border-border", surface: "border-border bg-muted/40 text-muted-foreground", text: "text-muted-foreground" };
}
