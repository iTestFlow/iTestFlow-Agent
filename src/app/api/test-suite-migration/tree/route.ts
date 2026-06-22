import { NextResponse } from "next/server";
import { authErrorResponse, getUserAzureAdapter, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { SuiteTreeRequestSchema } from "@/modules/test-suite-migration/test-suite-migration.schema";
import { loadMigrationSuiteTree } from "@/modules/test-suite-migration/test-suite-migration.service";
import { sanitizeAzureError } from "@/shared/lib/sanitize-azure-error";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const parsed = SuiteTreeRequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Selected project and test plan are required." }, { status: 400 });
  }

  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    const adapter = await getUserAzureAdapter(ctx, trustedScope);
    const suiteTree = await loadMigrationSuiteTree(adapter, {
      projectId: trustedScope.azureProjectId,
      testPlanId: parsed.data.testPlanId,
    });
    return NextResponse.json(
      { suiteTree },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return NextResponse.json(
      { error: error instanceof Error ? sanitizeAzureError(error.message) : "Azure Test Suite tree fetch failed." },
      { status: 503 },
    );
  }
}
