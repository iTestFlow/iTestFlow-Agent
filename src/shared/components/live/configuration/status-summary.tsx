"use client";

import { Card, CardContent } from "@/components/ui/card";
import type { StatusValue } from "./types";
import { StatusBadge } from "./section-card";

/** Three at-a-glance status cards shown at the top of the settings page. */
export function StatusSummary({
  azure,
  ai,
  sync,
}: {
  azure: StatusValue;
  ai: StatusValue;
  sync: StatusValue;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <StatusCard title="Azure DevOps" status={azure} />
      <StatusCard title="AI provider" status={ai} />
      <StatusCard title="Knowledge sync" status={sync} />
    </div>
  );
}

function StatusCard({ title, status }: { title: string; status: StatusValue }) {
  return (
    <Card>
      <CardContent className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-foreground">{title}</span>
          <StatusBadge tone={status.tone} label={status.label} />
        </div>
        <p className="min-h-4 text-xs leading-5 text-muted-foreground">{status.detail ?? ""}</p>
      </CardContent>
    </Card>
  );
}
