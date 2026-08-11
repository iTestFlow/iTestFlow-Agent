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
  createIntegrationOperation,
  IntegrationOperationError,
  listIntegrationOperations,
} from "@/modules/test-execution/integration-capabilities.service";

export const runtime = "nodejs";

const OperationSchema = z.object({
  stableKey: z.string().trim().regex(/^[a-z][a-z0-9_.-]{0,119}$/),
  displayName: z.string().trim().min(1).max(200),
  layer: z.enum(["api", "db"]),
  sourceKind: z.enum(["manual", "openapi"]).default("manual"),
  safetyClass: z.enum(["read", "mutation"]),
  databaseDriver: z.enum(["postgres", "sqlserver", "mysql"]).nullable().default(null),
  apiContractRevisionId: z.string().trim().min(1).nullable().default(null),
  parameterSchema: z.record(z.unknown()).default({}),
  definition: z.record(z.unknown()),
});

const CreateSchema = z.object({
  scope: ProjectScopeSchema,
  operation: OperationSchema,
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsedScope = ProjectScopeSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsedScope.success) {
    return NextResponse.json({ error: "Select an Azure DevOps project first." }, { status: 400 });
  }
  try {
    const ctx = await requireWorkflowContext(parsedScope.data.workspaceId);
    const includeAll = url.searchParams.get("includeAll") === "true";
    if (includeAll) {
      await requireWorkflowRole(
        ctx,
        ["owner", "admin"],
        "Only workspace owners and admins can view draft or archived integration operations.",
      );
    }
    const scope = await resolveProjectScope(ctx, parsedScope.data);
    const operations = await listIntegrationOperations({
      workspaceId: ctx.workspace.id,
      scope,
      includeAll,
    });
    return NextResponse.json(
      { operations },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { fallback: "Integration operations could not be loaded." });
  }
}

export async function POST(request: Request) {
  const parsed = CreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "The integration operation is not valid." },
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
    const operation = await createIntegrationOperation({
      workspaceId: ctx.workspace.id,
      scope,
      actor: ctx.userId,
      operation: parsed.data.operation,
    });
    return NextResponse.json({ operation }, { status: 201 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (error instanceof IntegrationOperationError) {
      return routeErrorResponse(error, { fallback: error.message, status: error.status });
    }
    return routeErrorResponse(error, { fallback: "The integration operation could not be created." });
  }
}
