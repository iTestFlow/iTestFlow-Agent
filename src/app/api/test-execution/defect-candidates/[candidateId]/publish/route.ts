import { NextResponse } from "next/server";
import { z } from "zod";

import {
  authErrorResponse,
  getUserAzureAdapter,
  requireWorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { checkRateLimit, clientIp } from "@/modules/security/rate-limit";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";
import {
  CandidateAlreadyPublishedError,
  CandidateNotFoundError,
  CandidatePublishInProgressError,
  publishDefectCandidate,
} from "@/modules/test-execution/defect-candidate.service";

export const runtime = "nodejs";
type RouteParams = { params: Promise<{ candidateId: string }> };

const RequestSchema = z.object({ scope: ProjectScopeSchema });

/**
 * Explicit, idempotent defect publication: the ledger's partial unique index
 * means a double click, a retry, or a concurrent request can never create a
 * second Azure DevOps bug for the same candidate.
 */
export async function POST(request: Request, { params }: RouteParams) {
  const rate = await checkRateLimit(`test-execution-publish:${clientIp(request)}`, 20, 5 * 60 * 1000);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many publish requests. Please wait a moment." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
    );
  }
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Select an Azure DevOps project first." }, { status: 400 });
  }
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const adapter = await getUserAzureAdapter(ctx, scope);
    const { candidateId } = await params;
    const result = await publishDefectCandidate({
      workspaceId: ctx.workspace.id,
      scope,
      actor: ctx.userId,
      adapter,
      candidateId,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (error instanceof CandidateNotFoundError) {
      return NextResponse.json({ error: "The defect candidate was not found." }, { status: 404 });
    }
    if (error instanceof CandidateAlreadyPublishedError) {
      return NextResponse.json(
        { error: "This candidate was already published.", azureBugId: error.azureBugId },
        { status: 409 },
      );
    }
    if (error instanceof CandidatePublishInProgressError) {
      return NextResponse.json(
        { error: "A publication for this candidate is already in progress." },
        { status: 409 },
      );
    }
    return routeErrorResponse(error, {
      domain: "azure",
      status: 503,
      fallback: "The defect could not be published to Azure DevOps.",
    });
  }
}
