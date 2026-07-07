import { NextResponse } from "next/server";
import { z } from "zod";

import {
  authErrorResponse,
  requireWorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";
import { verifyAndUpsertWorkspaceProject } from "@/modules/projects/workspace-projects.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";

const RequestSchema = z.object({
  workspaceId: z.string().min(1).optional(),
  azureProjectId: z.string().min(1),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Select an Azure DevOps project." }, { status: 400 });
  }

  try {
    const ctx = await requireWorkflowContext(parsed.data.workspaceId);
    const scope = await verifyAndUpsertWorkspaceProject(ctx, parsed.data.azureProjectId);
    return NextResponse.json({ scope });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { domain: "azure", status: 503, fallback: "Azure DevOps project selection failed." });
  }
}
