import { NextResponse } from "next/server";
import { z } from "zod";

import { authErrorResponse, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import {
  PROJECT_KNOWLEDGE_CANDIDATE_STATUSES,
  listProjectKnowledgeCandidates,
} from "@/modules/rag/project-knowledge-compiled.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  status: z.enum(PROJECT_KNOWLEDGE_CANDIDATE_STATUSES).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A valid project scope is required." }, { status: 400 });
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    return NextResponse.json({ candidates: await listProjectKnowledgeCandidates({ ...parsed.data, scope }) });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { fallback: "Project knowledge candidates could not be loaded." });
  }
}
