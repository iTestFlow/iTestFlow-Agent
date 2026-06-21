import { NextResponse } from "next/server";
import { z } from "zod";

import { getMyWorkbenchAnalytics } from "@/modules/dashboard/my-workbench.service";
import {
  authErrorResponse,
  getUserAzureAdapter,
  requireWorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  filters: z.object({
    sprintMode: z.enum(["current", "previous", "next", "all_active", "custom", "overall"]).optional(),
    iterationPath: z.string().max(512).optional().nullable(),
    workItemTypes: z.array(z.string().max(128)).max(100).optional(),
    states: z.array(z.string().max(128)).max(100).optional(),
    parentIds: z.array(z.string().max(64)).max(100).optional(),
    priority: z.enum(["all", "1", "2", "3", "4", "none"]).optional(),
    areaPath: z.string().max(512).optional().nullable(),
    includeCompleted: z.boolean().optional(),
    includeBacklog: z.boolean().optional(),
  }).optional(),
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
    return NextResponse.json({ error: "My Workbench dashboard request is invalid." }, { status: 400 });
  }

  try {
    const ctx = await requireWorkflowContext();
    const adapter = await getUserAzureAdapter(ctx, parsed.data.scope);
    return NextResponse.json(
      await getMyWorkbenchAnalytics({
        scope: parsed.data.scope,
        filters: parsed.data.filters,
      }, adapter),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load your Azure DevOps assigned work." },
      { status: 503 },
    );
  }
}
