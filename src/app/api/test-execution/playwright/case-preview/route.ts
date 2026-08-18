import { NextResponse } from "next/server";
import { z } from "zod";

import { authErrorResponse, getUserAzureAdapter, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";
import { deriveSuiteExecutionCases } from "@/modules/test-execution/execution-case-source.service";

export const runtime = "nodejs";

const Schema = z.object({
  scope: ProjectScopeSchema,
  testPlanId: z.coerce.number().int().positive(),
  testSuiteId: z.coerce.number().int().positive(),
});

export async function POST(request: Request) {
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Selected project, Test Plan, and Test Suite are required." }, { status: 400 });
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const adapter = await getUserAzureAdapter(ctx, scope);
    const cases = await deriveSuiteExecutionCases(adapter, {
      azureProjectId: scope.azureProjectId,
      testPlanId: parsed.data.testPlanId,
      testSuiteId: parsed.data.testSuiteId,
    });
    if (!cases.length) return NextResponse.json({ error: "No executable test cases were found in the selected suite tree." }, { status: 422 });
    return NextResponse.json({ cases }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const auth = authErrorResponse(error);
    if (auth) return auth;
    return routeErrorResponse(error, { domain: "azure", status: 503, fallback: "Test cases could not be loaded from the selected plan and suite." });
  }
}
