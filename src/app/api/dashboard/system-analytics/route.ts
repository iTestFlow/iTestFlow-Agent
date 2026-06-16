import { NextResponse } from "next/server";
import { z } from "zod";

import { workflowTypeValues } from "@/modules/analytics/analytics-config";
import { getSystemDashboardAnalytics } from "@/modules/analytics/system-dashboard.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";

export const runtime = "nodejs";

const CalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Enter a valid calendar date.");

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  filters: z.object({
    datePreset: z.enum(["7d", "14d", "30d", "custom"]).optional(),
    from: CalendarDateSchema.optional(),
    to: CalendarDateSchema.optional(),
    workflowTypes: z.array(z.enum(workflowTypeValues)).max(workflowTypeValues.length).optional(),
    userId: z.string().max(256).nullable().optional(),
  }).superRefine((filters, ctx) => {
    if (filters.datePreset !== "custom") return;
    if (!filters.from || !filters.to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["datePreset"], message: "Custom ranges require start and end dates." });
    } else if (filters.from > filters.to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["from"], message: "Start date must be on or before end date." });
    }
  }).optional(),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "System dashboard request is invalid." },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(
      getSystemDashboardAnalytics({
        scope: parsed.data.scope,
        filters: parsed.data.filters,
      }),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "System dashboard analytics failed." },
      { status: 503 },
    );
  }
}
