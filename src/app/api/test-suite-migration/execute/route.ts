import { NextResponse } from "next/server";
import { getProjectScopedAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";
import { SuiteMigrationRequestSchema } from "@/modules/test-suite-migration/test-suite-migration.schema";
import { executeSuiteMigration } from "@/modules/test-suite-migration/test-suite-migration.service";
import { sanitizeAzureError } from "@/shared/lib/sanitize-azure-error";
import {
  completeWorkflowRun,
  failWorkflowRun,
  startWorkflowRun,
} from "@/modules/analytics/workflow-analytics.service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const parsed = SuiteMigrationRequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Migration request is invalid." }, { status: 400 });
  }

  const analyticsRunId = startWorkflowRun({
    scope: parsed.data.scope,
    workflowType: "suite_migration",
    workItemId: parsed.data.selectedSuiteIds.join(","),
  });
  try {
    const adapter = getProjectScopedAzureDevOpsAdapter(parsed.data.scope);
    const result = await executeSuiteMigration(adapter, parsed.data);
    const successfulActions = result.report.actions.filter((action) => action.status === "success").length;
    if (successfulActions > 0) {
      completeWorkflowRun({
        scope: parsed.data.scope,
        runId: analyticsRunId,
        valueRealized: true,
        patch: {
          itemsGenerated: result.preview.totalSuiteCount,
          itemsSelected: result.preview.selectedRootSuiteCount,
          itemsPublished: result.report.summary.suitesCreated,
          manualActionsAvoided: successfulActions,
          metadata: { migration: result.report.summary },
        },
      });
    } else {
      failWorkflowRun({ scope: parsed.data.scope, runId: analyticsRunId, error: "Suite migration completed without successful actions." });
    }
    return NextResponse.json({ ...result, analyticsRunId });
  } catch (error) {
    failWorkflowRun({ scope: parsed.data.scope, runId: analyticsRunId, error: error instanceof Error ? error.message : "Suite migration failed." });
    return NextResponse.json(
      { error: error instanceof Error ? sanitizeAzureError(error.message) : "Suite migration failed." },
      { status: 503 },
    );
  }
}
