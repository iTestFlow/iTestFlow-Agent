import { NextResponse } from "next/server";
import { authErrorResponse, getUserAzureAdapter, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import { SuiteMigrationRequestSchema } from "@/modules/test-suite-migration/test-suite-migration.schema";
import { executeSuiteMigration } from "@/modules/test-suite-migration/test-suite-migration.service";
import { sanitizeAzureError } from "@/shared/lib/sanitize-azure-error";
import {
  completeWorkflowRun,
  failWorkflowRun,
  startWorkflowRun,
} from "@/modules/analytics/workflow-analytics.service";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const parsed = SuiteMigrationRequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Migration request is invalid." }, { status: 400 });
  }

  let trustedScope: ProjectScope | undefined;
  let analyticsRunId: string | undefined;
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    analyticsRunId = startWorkflowRun({
      scope: trustedScope,
      workflowType: "suite_migration",
      workItemId: parsed.data.selectedSuiteIds.join(","),
      userId: ctx.userId,
    });
    const adapter = await getUserAzureAdapter(ctx, trustedScope);
    const result = await executeSuiteMigration(adapter, { ...parsed.data, scope: trustedScope, actor: ctx.userId });
    const successfulActions = result.report.actions.filter((action) => action.status === "success").length;
    if (successfulActions > 0) {
      completeWorkflowRun({
        scope: trustedScope,
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
      failWorkflowRun({ scope: trustedScope, runId: analyticsRunId, error: "Suite migration completed without successful actions." });
    }
    return NextResponse.json({ ...result, analyticsRunId });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (trustedScope && analyticsRunId) {
      failWorkflowRun({ scope: trustedScope, runId: analyticsRunId, error: error instanceof Error ? error.message : "Suite migration failed." });
    }
    return NextResponse.json(
      { error: error instanceof Error ? sanitizeAzureError(error.message) : "Suite migration failed." },
      { status: 503 },
    );
  }
}
