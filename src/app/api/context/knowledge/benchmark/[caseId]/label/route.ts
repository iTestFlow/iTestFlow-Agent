import { NextResponse } from "next/server";
import { z } from "zod";
import { authErrorResponse, requireWorkflowContext, requireWorkflowRole } from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { labelProjectKnowledgeBenchmarkCase } from "@/modules/rag/project-knowledge-benchmark.service";
import { normalizeExpectedWorkItemId } from "@/modules/rag/work-item-id";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";

const RequestSchema = z
  .object({
    scope: ProjectScopeSchema,
    expectedWorkItemId: z.string().trim().min(1).max(200).optional(),
    expectedAnswerSnippet: z.string().trim().min(1).max(2000).optional(),
  })
  // Without at least one field the write would null the label while still stamping
  // labeled_at/labeled_by — a shape no caller legitimately sends.
  .refine((data) => data.expectedWorkItemId !== undefined || data.expectedAnswerSnippet !== undefined, {
    message: "Provide an expected work item ID or an answer snippet.",
  });
type RouteParams = { params: Promise<{ caseId: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "A valid benchmark label is required." }, { status: 400 });
  }

  // Retrieval returns plain numeric work item ids, so anything else stored here would
  // silently score zero forever. Reject un-normalizable input at the door.
  const expectedWorkItemId =
    parsed.data.expectedWorkItemId === undefined
      ? undefined
      : normalizeExpectedWorkItemId(parsed.data.expectedWorkItemId);
  if (expectedWorkItemId === null) {
    return NextResponse.json(
      { error: 'Expected work item must be a work item ID like "1234" or "AB#1234" (a work item URL also works).' },
      { status: 400 },
    );
  }

  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    await requireWorkflowRole(ctx, ["owner", "admin"], "Only workspace owners and admins can label retrieval benchmark cases.");
    const trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    const { caseId } = await params;
    return NextResponse.json({
      case: await labelProjectKnowledgeBenchmarkCase({
        scope: trustedScope,
        caseId,
        expectedWorkItemId,
        expectedAnswerSnippet: parsed.data.expectedAnswerSnippet,
        labeledBy: ctx.userId,
      }),
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { fallback: "The benchmark case could not be labeled." });
  }
}
