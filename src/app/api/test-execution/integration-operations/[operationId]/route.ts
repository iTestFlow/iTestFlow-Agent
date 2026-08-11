import { NextResponse } from "next/server";
import { z } from "zod";

import {
  authErrorResponse,
  requireWorkflowContext,
  requireWorkflowRole,
} from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";
import {
  IntegrationOperationError,
  transitionIntegrationOperation,
} from "@/modules/test-execution/integration-capabilities.service";

export const runtime = "nodejs";
type RouteParams = { params: Promise<{ operationId: string }> };

const ChangesSchema = z.object({
  displayName: z.string().trim().min(1).max(200).optional(),
  sourceKind: z.enum(["manual", "openapi"]).optional(),
  safetyClass: z.enum(["read", "mutation"]).optional(),
  databaseDriver: z.enum(["postgres", "sqlserver", "mysql"]).nullable().optional(),
  apiContractRevisionId: z.string().trim().min(1).nullable().optional(),
  parameterSchema: z.record(z.unknown()).optional(),
  definition: z.record(z.unknown()).optional(),
}).strict();

const MutationSchema = z.object({
  scope: ProjectScopeSchema,
  action: z.enum(["revise", "approve", "archive"]),
  changes: ChangesSchema.default({}),
});

export async function PATCH(request: Request, { params }: RouteParams) {
  const parsed = MutationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "The operation update is not valid." },
      { status: 400 },
    );
  }
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    await requireWorkflowRole(
      ctx,
      ["owner", "admin"],
      "Only workspace owners and admins can manage integration operations.",
    );
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const { operationId } = await params;
    const operation = await transitionIntegrationOperation({
      workspaceId: ctx.workspace.id,
      scope,
      actor: ctx.userId,
      operationRevisionId: operationId,
      action: parsed.data.action,
      changes: parsed.data.changes,
    });
    return operation
      ? NextResponse.json({ operation })
      : NextResponse.json({ error: "The integration operation was not found." }, { status: 404 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (error instanceof IntegrationOperationError) {
      return routeErrorResponse(error, { fallback: error.message, status: error.status });
    }
    return routeErrorResponse(error, { fallback: "The integration operation could not be updated." });
  }
}
