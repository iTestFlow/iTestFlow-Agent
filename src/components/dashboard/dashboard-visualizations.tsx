"use client";

import { Info } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { DashboardDistributionDatum } from "@/types/dashboard";

const semanticColors: Record<string, string> = {
  passed: "hsl(var(--success))",
  covered: "hsl(var(--success))",
  ready: "hsl(var(--success))",
  failed: "hsl(var(--destructive))",
  critical: "hsl(var(--destructive))",
  high: "hsl(var(--chart-6))",
  blocked: "hsl(var(--warning))",
  medium: "hsl(var(--warning))",
  "not run": "hsl(var(--muted-foreground))",
  uncovered: "hsl(var(--destructive))",
  "skipped / n/a": "hsl(var(--chart-4))",
  low: "hsl(var(--chart-2))",
  unknown: "hsl(var(--muted-foreground))",
  "priority 1": "hsl(var(--destructive))",
  "priority 2": "hsl(var(--chart-6))",
  "priority 3": "hsl(var(--warning))",
  "priority 4": "hsl(var(--chart-2))",
  "no priority": "hsl(var(--muted-foreground))",
};

const palette = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
  "hsl(var(--chart-6))",
];

export function DashboardChartCard({
  title,
  description,
  emptyMessage,
  hasData,
  summary,
  notice,
  className,
  children,
}: {
  title: string;
  description?: string;
  emptyMessage: string;
  hasData: boolean;
  summary?: string;
  notice?: string | null;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className={cn("qa-card min-w-0", className)}>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        {description ? <p className="text-xs leading-5 text-muted-foreground">{description}</p> : null}
      </CardHeader>
      <CardContent>
        {summary ? <p className="sr-only">{summary}</p> : null}
        {notice && hasData ? (
          <div className="mb-3 flex items-center gap-2 rounded-md border border-primary/15 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
            <Info className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
            <span>{notice}</span>
          </div>
        ) : null}
        {hasData ? children : <EmptyChartState message={emptyMessage} />}
      </CardContent>
    </Card>
  );
}

export function EmptyChartState({ message }: { message: string }) {
  return (
    <div className="flex h-[260px] items-center justify-center rounded-lg border border-dashed border-border bg-muted/20 px-6 text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

export function DonutChart({ data, centerLabel }: { data: DashboardDistributionDatum[]; centerLabel?: string }) {
  const total = data.reduce((sum, item) => sum + item.value, 0);
  return (
    <div className="min-w-0">
      <div className="relative h-[220px]">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={62} outerRadius={92} paddingAngle={2}>
              {data.map((item, index) => (
                <Cell key={item.key ?? item.name} fill={colorFor(item.name, index)} />
              ))}
            </Pie>
            <Tooltip content={<DashboardTooltip />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-center">
          <div>
            <div className="text-2xl font-bold text-foreground">{total}</div>
            <div className="text-[11px] text-muted-foreground">{centerLabel ?? "Total"}</div>
          </div>
        </div>
      </div>
      <div className="flex min-h-8 flex-wrap items-center justify-center gap-x-3 gap-y-1 pt-1 text-xs text-muted-foreground">
        {data.map((item, index) => (
          <span key={item.key ?? item.name} className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <span className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: colorFor(item.name, index) }} />
            {item.name}
          </span>
        ))}
      </div>
    </div>
  );
}

export function DistributionBarChart({ data }: { data: DashboardDistributionDatum[] }) {
  return (
    <div className="h-[260px]">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 4 }}>
          <CartesianGrid stroke="hsl(var(--border))" vertical={false} />
          <XAxis dataKey="name" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} tickLine={false} axisLine={false} />
          <YAxis allowDecimals={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} tickLine={false} axisLine={false} />
          <Tooltip content={<DashboardTooltip />} cursor={{ fill: "hsl(var(--muted) / 0.45)" }} />
          <Bar dataKey="value" radius={[6, 6, 2, 2]}>
            {data.map((item, index) => <Cell key={item.name} fill={colorFor(item.name, index)} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

type TooltipPayload = {
  name?: string | number;
  value?: string | number;
  color?: string;
  fill?: string;
};

function DashboardTooltip({
  active,
  payload,
  label,
  suffix = "",
}: {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string | number;
  suffix?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg">
      {label ? <div className="mb-1 font-semibold">{String(label)}</div> : null}
      <div className="space-y-1">
        {payload.map((item) => (
          <div key={`${String(item.name)}-${String(item.value)}`} className="flex items-center gap-2">
            <span className="size-2 rounded-full" style={{ backgroundColor: item.color ?? item.fill }} />
            <span className="text-muted-foreground">{item.name}</span>
            <span className="font-semibold text-foreground">{item.value}{suffix}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function colorFor(name: string, index: number) {
  return semanticColors[name.toLowerCase()] ?? palette[index % palette.length];
}
