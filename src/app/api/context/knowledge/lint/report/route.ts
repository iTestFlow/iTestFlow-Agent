import { NextResponse } from "next/server";
import { z } from "zod";

import { authErrorResponse, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { reportProjectKnowledgeLintMiss } from "@/modules/rag/project-knowledge-compiled.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  missType: z.enum(["duplicate", "conflict"]),
  title: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(2000),
  category: z.string().optional(),
  entryKey: z.string().optional(),
  sourceWorkItemIds: z.array(z.string()).optional(),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Describe the missed duplicate or conflict." }, { status: 400 });
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    return NextResponse.json({ issues: await reportProjectKnowledgeLintMiss({ ...parsed.data, scope, actor: ctx.userId }) });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { fallback: "The lint miss could not be reported." });
  }
}
