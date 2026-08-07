import { NextResponse } from "next/server";
import { z } from "zod";

import {
  authErrorResponse,
  getUserAzureAdapter,
  requireWorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";
import { fetchProjectScopedSuiteTestCases } from "@/modules/integrations/azure-devops/azure-devops-suite-test-cases.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  testPlanId: z.string().trim().min(1),
  testSuiteId: z.string().trim().min(1),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Selected project, test plan, and suite are required." },
      { status: 400 },
    );
  }

  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    const adapter = await getUserAzureAdapter(ctx, trustedScope);
    const testCases = await fetchProjectScopedSuiteTestCases(adapter, trustedScope, {
      actor: ctx.userId,
      testPlanId: parsed.data.testPlanId,
      testSuiteId: parsed.data.testSuiteId,
    });
    return NextResponse.json({ testCases });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { domain: "azure", status: 503, fallback: "Suite test case fetch failed." });
  }
}
