import { NextResponse } from "next/server";
import { z } from "zod";
import { authErrorResponse, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { PROJECT_KNOWLEDGE_JOB } from "@/modules/jobs/project-knowledge-jobs.service";
import { hasHealthyWorkerCapability } from "@/modules/jobs/worker-registry.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { getProjectKnowledgeBaseSnapshot } from "@/modules/rag/project-knowledge.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Please select an Azure DevOps project before loading the knowledge base." }, { status: 400 });
  }

  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    const [snapshot, generationAvailable] = await Promise.all([
      getProjectKnowledgeBaseSnapshot({ scope: trustedScope }),
      hasHealthyWorkerCapability(PROJECT_KNOWLEDGE_JOB),
    ]);
    return NextResponse.json({ snapshot, generationAvailable });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { domain: "generic", status: 503, fallback: "Project knowledge status failed." });
  }
}
