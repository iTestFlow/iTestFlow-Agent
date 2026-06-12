"use client";

import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  Bug,
  CheckCircle2,
  CircleHelp,
  ClipboardCheck,
  Gauge,
  RefreshCcw,
  ShieldAlert,
  TestTube2,
} from "lucide-react";

import { StatusChip } from "@/components/qa/status-chip";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type {
  DashboardActionItem,
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
    return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 8 }).map((_, index) => <Skeleton key={index} className="h-[138px] rounded-xl" />)}</div>;
  }
  if (!data) return null;
  const kpis = data.kpis;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <ReadinessKpi status={kpis.releaseReadiness.status} score={kpis.releaseReadiness.score} reasons={kpis.releaseReadiness.reasons} onClick={() => onNavigate("readiness")} />
      <MetricKpi label="Blocked Tests" metric={kpis.blockedTests} icon={Ban} alert={Boolean(kpis.blockedTests.value)} onClick={() => onNavigate("blockers")} />
      <MetricKpi label="Open Critical / High" metric={kpis.openCriticalHighBugs} icon={ShieldAlert} alert={Boolean(kpis.openCriticalHighBugs.value)} onClick={() => onNavigate("bugs")} />
      <MetricKpi label="Retest Pending" metric={kpis.retestPending} icon={RefreshCcw} alert={Boolean(kpis.retestPending.value)} help="Bugs in a resolved or fixed state that have not reached a completed state." onClick={() => onNavigate("bugs")} />
      <MetricKpi label="Test Execution Progress" metric={kpis.testExecutionProgress} icon={TestTube2} format="percentage" help="Executed test points divided by all selected Azure Test Plan points. Skipped/N/A counts as executed." onClick={() => onNavigate("testing")} />
      <MetricKpi label="Pass Rate" metric={kpis.passRate} icon={CheckCircle2} format="percentage" help="Passed outcomes divided by passed, failed, and blocked outcomes. Skipped/N/A is excluded." onClick={() => onNavigate("testing")} />
      <MetricKpi label="Requirements Coverage" metric={kpis.requirementsCoverage} icon={ClipboardCheck} format="percentage" help="Requirements with at least one linked Azure Test Case divided by all requirements in scope." onClick={() => onNavigate("coverage")} />
      <MetricKpi label="Open Bugs" metric={kpis.openBugs} icon={Bug} secondary onClick={() => onNavigate("bugs")} />
    </div>
  );
}

export function ActionRequiredPanel({
  actions,
  onNavigate,
}: {
  actions: DashboardActionItem[];
  onNavigate: (target: DashboardTab | "readiness") => void;
}) {
  return (
    <Card className="qa-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base">Action Required</CardTitle>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Prioritized from the current dashboard metrics and release gates.</p>
          </div>
          {actions.length ? <span className="rounded-full bg-destructive/10 px-2.5 py-1 text-xs font-semibold text-destructive">{actions.length}</span> : null}
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {actions.length ? (
          <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {actions.map((action, index) => (
              <button
                key={action.id}
                type="button"
                className="group flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                onClick={() => onNavigate(action.target)}
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold tabular-nums text-muted-foreground" aria-label={`Priority ${index + 1}`}>
                  {index + 1}
                </span>
                <StatusChip tone={actionTone(action.severity)}>{titleCase(action.severity)}</StatusChip>
                <span className="min-w-0 flex-1 text-sm text-foreground">{action.message}</span>
                <span className="hidden shrink-0 items-center gap-1 text-xs font-semibold text-primary sm:inline-flex">
                  {action.actionLabel}<ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-lg border border-success/25 bg-success/10 px-3 py-2.5 text-sm text-foreground">
            <CheckCircle2 className="size-4 shrink-0 text-success" />
            No immediate QA actions detected for the selected scope.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ReleaseReadinessCard({ data }: { data: DashboardAnalytics["releaseReadiness"] }) {
  const config = readinessConfig(data.status);
  const Icon = config.icon;
  return (
    <Card id="release-readiness" className={cn("qa-card scroll-mt-20 overflow-hidden border-l-4", config.border)}>
      <CardContent className="grid gap-5 p-5 lg:grid-cols-[250px_1fr] lg:items-center">
        <div className="flex items-center gap-4">
          <div className={cn("rounded-xl border p-3", config.surface)}><Icon className="size-6" /></div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Release Decision</div>
            <div className="mt-1 text-2xl font-bold text-foreground">{config.label}</div>
            <div className="mt-2 text-xs text-muted-foreground">{data.score === null ? "Score unavailable" : `Readiness score ${data.score}/100`}</div>
          </div>
        </div>
        <div className="border-t border-border/70 pt-4 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
          <div className="text-xs font-medium uppercase tracking-normal text-muted-foreground">Primary reason</div>
          <p className="mt-1 text-base font-semibold leading-6 text-foreground">{sentenceCase(data.reasons[0] ?? data.summary)}</p>
          {data.reasons.length > 1 ? (
            <ul className="mt-3 grid gap-x-5 gap-y-1 text-xs leading-5 text-muted-foreground md:grid-cols-2" aria-label="Supporting release factors">
              {data.reasons.slice(1, 6).map((reason) => <li key={reason} className="flex gap-2"><span aria-hidden="true">-</span><span>{sentenceCase(reason)}</span></li>)}
            </ul>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function ReadinessKpi({
  status,
  score,
  reasons,
  onClick,
}: {
  status: DashboardReadinessStatus;
  score: number | null;
  reasons: string[];
  onClick: () => void;
}) {
  const config = readinessConfig(status);
  const Icon = config.icon;
  return (
    <KpiSurface label="View release readiness details" onClick={onClick}>
      <Card className={cn("qa-card h-full", config.border)}>
        <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
          <CardTitle className="text-xs font-medium uppercase tracking-normal text-muted-foreground">Release Decision</CardTitle>
          <Icon className={cn("size-4", config.text)} />
        </CardHeader>
        <CardContent>
          <div className="flex items-baseline justify-between gap-2"><span className="text-2xl font-bold">{config.label}</span><span className="text-xs text-muted-foreground">{score === null ? "No score" : `${score}/100`}</span></div>
          {score !== null ? <Progress value={score} className="mt-3 h-1.5" /> : null}
          <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">{reasons[0] ?? "All configured gates are satisfied."}</p>
        </CardContent>
      </Card>
    </KpiSurface>
  );
}

function MetricKpi({
  label,
  metric,
  icon: Icon,
  format = "number",
  alert,
  help,
  secondary,
  onClick,
}: {
  label: string;
  metric: DashboardMetric;
  icon: LucideIcon;
  format?: "number" | "percentage";
  alert?: boolean;
  help?: string;
  secondary?: boolean;
  onClick: () => void;
}) {
  const display = metric.available && metric.value !== null ? `${metric.value}${format === "percentage" ? "%" : ""}` : "Unknown";
  return (
    <KpiSurface label={`View ${label}`} onClick={onClick}>
      <Card className={cn("qa-card h-full", alert && "border-destructive/30", secondary && "bg-muted/15")}>
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

function actionTone(severity: DashboardActionItem["severity"]) {
  if (severity === "critical" || severity === "high") return "error" as const;
  if (severity === "medium") return "warning" as const;
  return "info" as const;
}

function titleCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
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
