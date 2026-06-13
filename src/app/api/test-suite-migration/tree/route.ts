import { NextResponse } from "next/server";
import { getProjectScopedAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";
import { SuiteTreeRequestSchema } from "@/modules/test-suite-migration/test-suite-migration.schema";
import { loadMigrationSuiteTree } from "@/modules/test-suite-migration/test-suite-migration.service";
import { sanitizeAzureError } from "@/shared/lib/sanitize-azure-error";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const parsed = SuiteTreeRequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Selected project and test plan are required." }, { status: 400 });
  }

  try {
    const adapter = getProjectScopedAzureDevOpsAdapter(parsed.data.scope);
    const suiteTree = await loadMigrationSuiteTree(adapter, {
      projectId: parsed.data.scope.azureProjectId,
      testPlanId: parsed.data.testPlanId,
    });
    return NextResponse.json(
      { suiteTree },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? sanitizeAzureError(error.message) : "Azure Test Suite tree fetch failed." },
      { status: 503 },
    );
  }
}
