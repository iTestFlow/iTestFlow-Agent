"use client";

import { ChevronDown, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  Bar,
  BarChart as RechartsBarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type {
  DashboardActivityDatum,
  DashboardChartDatum,
  DashboardRecentActivity,
} from "@/types/dashboard";
import { Button } from "@/components/ui/button";
import { toneClass } from "@/components/qa/tone";
import { cn } from "@/lib/utils";

const palette = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
  "hsl(var(--chart-6))",
];

type Tone = "blue" | "green" | "purple" | "cyan" | "yellow" | "red";

const iconToneClasses: Record<Tone, string> = {
  blue: toneClass.primary,
  green: toneClass.success,
  purple: toneClass.draft,
  cyan: toneClass.info,
  yellow: toneClass.warning,
  red: toneClass.error,
};

function hasValues(data: Array<{ value?: number }>) {
  return data.some((item) => (item.value ?? 0) > 0);
}

function EmptyChart({ label = "No local data yet" }: { label?: string }) {
  return (
    <div className="flex h-full min-h-[220px] items-center justify-center rounded-xl border border-dashed border-border bg-muted/30 px-4 text-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}

type ChartTooltipPayload = {
  name?: string | number;
  value?: string | number;
  color?: string;
  fill?: string;
};

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: ChartTooltipPayload[];
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg">
      <div className="mb-1 font-semibold">{label}</div>
      <div className="space-y-1">
        {payload.map((item) => (
          <div key={`${String(item.name)}-${String(item.value)}`} className="flex items-center gap-2">
            <span
              className="size-2 rounded-full"
              style={{ backgroundColor: item.color ?? item.fill }}
            />
            <span className="text-muted-foreground">{item.name}</span>
            <span className="font-semibold text-foreground">{item.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function MetricCard({
  title,
  value,
  description,
  icon: Icon,
  tone = "blue",
}: {
  title: string;
  value: string;
  description: string;
  icon: LucideIcon;
  tone?: Tone;
}) {
  return (
    <section className="qa-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">{title}</p>
          <div className="mt-2 truncate text-2xl font-bold text-foreground">{value}</div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
        </div>
        <div className={cn("rounded-lg border p-2", iconToneClasses[tone])}>
          <Icon className="size-4" aria-hidden="true" />
        </div>
      </div>
    </section>
  );
}

export function InfoBanner({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-primary/20 bg-primary/10 px-4 py-3 text-sm text-foreground shadow-sm">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="font-semibold text-primary">{title}</div>
          <p className="mt-1 leading-6 text-muted-foreground">{description}</p>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </section>
  );
}

export function ChartCard({
  title,
  description,
  marker = "blue",
  children,
}: {
  title: string;
  description?: string;
  marker?: Tone;
  children: React.ReactNode;
}) {
  const markerClass = {
    blue: "bg-[hsl(var(--chart-1))]",
    green: "bg-[hsl(var(--chart-2))]",
    purple: "bg-[hsl(var(--chart-3))]",
    cyan: "bg-[hsl(var(--chart-4))]",
    yellow: "bg-[hsl(var(--chart-5))]",
    red: "bg-[hsl(var(--chart-6))]",
  }[marker];

  return (
    <section className="qa-card p-5">
      <div className="mb-5 flex items-start gap-2">
        <span className={cn("mt-1.5 size-2 rounded-full", markerClass)} />
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          {description ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

export function VerticalBarChart({ data }: { data: DashboardChartDatum[] }) {
  if (!hasValues(data)) return <EmptyChart />;

  return (
    <div className="h-[260px]">
      <ResponsiveContainer width="100%" height="100%">
        <RechartsBarChart data={data} margin={{ top: 5, right: 8, left: -18, bottom: 0 }}>
          <CartesianGrid stroke="hsl(var(--border))" vertical={false} />
          <XAxis dataKey="name" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} tickLine={false} axisLine={false} />
          <YAxis allowDecimals={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} tickLine={false} axisLine={false} />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: "hsl(var(--muted) / 0.45)" }} />
          <Bar dataKey="value" radius={[8, 8, 3, 3]}>
            {data.map((entry, index) => (
              <Cell key={entry.name} fill={palette[index % palette.length]} />
            ))}
          </Bar>
        </RechartsBarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function HorizontalBarChart({ data }: { data: DashboardChartDatum[] }) {
  if (!hasValues(data)) return <EmptyChart />;

  return (
    <div className="h-[260px]">
      <ResponsiveContainer width="100%" height="100%">
        <RechartsBarChart data={data} layout="vertical" margin={{ top: 5, right: 12, left: 24, bottom: 0 }}>
          <CartesianGrid stroke="hsl(var(--border))" horizontal={false} />
          <XAxis type="number" allowDecimals={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} tickLine={false} axisLine={false} />
          <YAxis dataKey="name" type="category" width={86} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} tickLine={false} axisLine={false} />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: "hsl(var(--muted) / 0.45)" }} />
          <Bar dataKey="value" radius={[3, 8, 8, 3]}>
            {data.map((entry, index) => (
              <Cell key={entry.name} fill={palette[index % palette.length]} />
            ))}
          </Bar>
        </RechartsBarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ActivityBarChart({ data }: { data: DashboardActivityDatum[] }) {
  const total = data.reduce((sum, item) => sum + item.Requirement + item["Test cases"] + item.Coverage + item.Publish, 0);
  if (!total) return <EmptyChart label="No workflow runs in the last 14 days" />;

  return (
    <div className="h-[300px]">
      <ResponsiveContainer width="100%" height="100%">
        <RechartsBarChart data={data} margin={{ top: 5, right: 8, left: -18, bottom: 0 }}>
          <CartesianGrid stroke="hsl(var(--border))" vertical={false} />
          <XAxis dataKey="day" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} tickLine={false} axisLine={false} />
          <YAxis allowDecimals={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} tickLine={false} axisLine={false} />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: "hsl(var(--muted) / 0.45)" }} />
          <Bar dataKey="Requirement" stackId="runs" fill="hsl(var(--chart-1))" radius={[3, 3, 0, 0]} />
          <Bar dataKey="Test cases" stackId="runs" fill="hsl(var(--chart-2))" radius={[3, 3, 0, 0]} />
          <Bar dataKey="Coverage" stackId="runs" fill="hsl(var(--chart-3))" radius={[3, 3, 0, 0]} />
          <Bar dataKey="Publish" stackId="runs" fill="hsl(var(--chart-5))" radius={[8, 8, 3, 3]} />
        </RechartsBarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function StatusBreakdown({ data }: { data: DashboardChartDatum[] }) {
  if (!hasValues(data)) return <EmptyChart />;
  const total = data.reduce((sum, item) => sum + item.value, 0);

  return (
    <div className="space-y-4">
      {data.map((item, index) => {
        const percent = total ? Math.round((item.value / total) * 100) : 0;
        return (
          <div key={item.name}>
            <div className="mb-2 flex items-center justify-between gap-3 text-sm">
              <span className="truncate text-foreground">{item.name}</span>
              <span className="font-mono text-xs text-muted-foreground">{item.value} / {percent}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full"
                style={{ width: `${percent}%`, backgroundColor: palette[index % palette.length] }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function RecentActivityList({
  items,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  emptyLabel = "No recent local activity yet",
}: {
  items: DashboardRecentActivity[];
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  emptyLabel?: string;
}) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  function toggleActivity(id: string) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  if (!items.length) {
    return <EmptyChart label={emptyLabel} />;
  }

  return (
    <div className="space-y-3">
      {items.map((item) => {
        const expanded = expandedIds.has(item.id);
        const label = expanded ? "Hide audit details" : "Show audit details";

        return (
          <div key={item.id} className="rounded-xl border border-border bg-background/60 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-foreground">{item.action}</div>
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{item.message}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="rounded-full border border-border bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground">
                  {item.status}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-expanded={expanded}
                  aria-label={`${label} for ${item.action}`}
                  title={label}
                  onClick={() => toggleActivity(item.id)}
                >
                  <ChevronDown className={cn("size-4 transition-transform", expanded && "rotate-180")} aria-hidden="true" />
                </Button>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{item.projectName ?? "All projects"}</span>
              <span aria-hidden="true">/</span>
              <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>
            </div>
            {expanded ? (
              <pre className="mt-3 max-h-96 overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs leading-5 text-muted-foreground">
                {JSON.stringify(item.audit, null, 2)}
              </pre>
            ) : null}
          </div>
        );
      })}
      {hasMore && onLoadMore ? (
        <div className="flex justify-center pt-1">
          <Button type="button" variant="outline" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? "Loading..." : "Load more"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
