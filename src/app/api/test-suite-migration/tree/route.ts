import { NextResponse } from "next/server";
import { getConfiguredAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";
import { SuiteTreeRequestSchema } from "@/modules/test-suite-migration/test-suite-migration.schema";
import { loadMigrationSuiteTree } from "@/modules/test-suite-migration/test-suite-migration.service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const parsed = SuiteTreeRequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Selected project and test plan are required." }, { status: 400 });
  }

  try {
    const adapter = getConfiguredAzureDevOpsAdapter();
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

function sanitizeAzureError(value: string) {
  return value
    .replace(/Authorization:\s*Basic\s+[A-Za-z0-9+/=]+/gi, "Authorization: Basic [redacted]")
    .replace(/Basic\s+[A-Za-z0-9+/=]{20,}/g, "Basic [redacted]")
    .replace(/personalAccessToken["'\s:=]+[^"',\s}]+/gi, "personalAccessToken: [redacted]")
    .replace(/pat["'\s:=]+[^"',\s}]+/gi, "PAT: [redacted]");
}
