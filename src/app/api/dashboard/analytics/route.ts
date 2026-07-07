import { NextResponse } from "next/server";
import { z } from "zod";

import { getDashboardAnalytics } from "@/modules/dashboard/dashboard-analytics.service";
import {
  authErrorResponse,
  getUserAzureAdapter,
  requireWorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";

const isRealCalendarDate = (value: string) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  filters: z.object({
    datePreset: z.enum(["7d", "14d", "30d", "current_sprint", "custom"]).optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    testPlanId: z.string().max(64).optional().nullable(),
    testSuiteIds: z.array(z.string().max(64)).max(100).optional(),
    areaPath: z.string().max(512).optional().nullable(),
    iterationPath: z.string().max(512).optional().nullable(),
    workItemTypes: z.array(z.string().max(128)).max(20).optional(),
    assignee: z.string().max(256).optional().nullable(),
  })
    .superRefine((filters, ctx) => {
      for (const field of ["from", "to"] as const) {
        const value = filters[field];
        if (value !== undefined && !isRealCalendarDate(value)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${field} must be a real calendar date`, path: [field] });
        }
      }
      if (filters.datePreset === "custom") {
        if (!filters.from || !filters.to) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A custom range requires both from and to dates.", path: ["datePreset"] });
        } else if (filters.from > filters.to) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "from must be on or before to.", path: ["from"] });
        }
      }
    })
    .optional(),
  bypassCache: z.boolean().optional(),
});

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json({ error: "Dashboard analytics request is invalid." }, { status: 400 });
  }

  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    const adapter = await getUserAzureAdapter(ctx, trustedScope);
    return NextResponse.json(
      await getDashboardAnalytics({
        scope: trustedScope,
        filters: parsed.data.filters,
        bypassCache: parsed.data.bypassCache,
      }, adapter),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, {
      domain: "azure",
      status: 503,
      fallback: "Dashboard analytics failed.",
    });
  }
}
