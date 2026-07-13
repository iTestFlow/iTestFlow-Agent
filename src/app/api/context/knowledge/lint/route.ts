import { NextResponse } from "next/server";
import { z } from "zod";
import { authErrorResponse, requireWorkflowContext, requireWorkflowRole } from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { getProjectKnowledgeLintIssues, runProjectKnowledgeLint } from "@/modules/rag/project-knowledge-compiled.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  run: z.boolean().optional().default(false),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Please select an Azure DevOps project before running knowledge health checks." }, { status: 400 });
  }

  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    if (parsed.data.run) {
      await requireWorkflowRole(ctx, ["owner", "admin"], "Only workspace owners and admins can run project knowledge lint.");
    }
    const trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    if (parsed.data.run) return NextResponse.json(await runProjectKnowledgeLint({ scope: trustedScope }));
    const issues = await getProjectKnowledgeLintIssues({ scope: trustedScope });
    const activeIssues = issues.filter((issue) => issue.status === "open" || issue.status === "reported");
    return NextResponse.json({
      issues,
      summary: {
        total: activeIssues.length,
        errors: activeIssues.filter((issue) => issue.severity === "error").length,
        warnings: activeIssues.filter((issue) => issue.severity === "warning").length,
        info: activeIssues.filter((issue) => issue.severity === "info").length,
      },
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { domain: "generic", status: 503, fallback: "Project knowledge lint failed." });
  }
}
