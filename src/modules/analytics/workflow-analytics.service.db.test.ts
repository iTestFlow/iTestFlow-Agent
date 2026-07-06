import { afterAll, expect, it } from "vitest";

import { describeDb, uniqueTestId } from "@/test/db";
import {
  flushBackgroundWrites,
  resetDatabaseForTests,
  sqlGet,
  sqlRun,
} from "@/modules/shared/infrastructure/database/db";
import {
  defaultReviewBaselines,
  defaultWorkflowBaselines,
} from "@/modules/analytics/analytics-config";
import {
  completeWorkflowRun,
  failWorkflowRun,
  startWorkflowRun,
  updateWorkflowRun,
} from "@/modules/analytics/workflow-analytics.service";

// Per-run-unique scope: the integration lane shares one Postgres with concurrent
// runs, and analytics_workflow_runs has no FK to projects, so no workspace/project
// seeding is required — unique IDs alone keep this file's rows isolated.
const scope = {
  projectId: uniqueTestId("proj_wfa"),
  azureProjectId: uniqueTestId("azproj_wfa"),
  azureProjectName: "Workflow Analytics Savings",
  azureOrganizationUrl: "https://dev.azure.com/workflow-analytics-savings",
};
const userId = uniqueTestId("user_wfa");

// scope.workspaceId is unset, so both baselines resolve to the deployment defaults.
const MANUAL_TCD = defaultWorkflowBaselines.test_case_design;
const REVIEW_PER_ITEM_TCD = defaultReviewBaselines.test_case_design; // per-item workflow
const MANUAL_BOA = defaultWorkflowBaselines.business_owner_assistant;
const REVIEW_PER_RUN_BOA = defaultReviewBaselines.business_owner_assistant; // per-run workflow

// Deterministic LLM window: exactly 6 elapsed minutes between the two timestamps.
const GENERATION_STARTED_AT = "2026-07-06T10:00:00.000Z";
const GENERATION_COMPLETED_AT = "2026-07-06T10:06:00.000Z";
const GENERATION_MINUTES = 6;

// DB-backed integration test. Requires a migrated PostgreSQL reachable via DATABASE_URL
// (e.g. `docker compose --profile test up -d postgres-test`, point DATABASE_URL at it,
// then `npm run db:migrate`). Skipped when DATABASE_URL is unset so the default unit
// test run requires no database (ADR-9).

describeDb("workflow analytics savings metrics (DB-backed)", () => {
  afterAll(async () => {
    await sqlRun(
      `DELETE FROM analytics_workflow_runs
       WHERE project_id = @projectId AND azure_project_id = @azureProjectId`,
      { projectId: scope.projectId, azureProjectId: scope.azureProjectId },
    );
    await resetDatabaseForTests();
  });

  it("persists labor saved = baseline - review and cycle saved = baseline - (generation + review)", async () => {
    const runId = startWorkflowRun({
      scope,
      workflowType: "test_case_design",
      userId,
      generationStartedAt: GENERATION_STARTED_AT,
    });
    completeWorkflowRun({
      scope,
      runId,
      valueRealized: true,
      patch: { itemsGenerated: 5, generationCompletedAt: GENERATION_COMPLETED_AT },
    });
    // Analytics writes are enqueued on a serialized background queue; flush before reading.
    await flushBackgroundWrites();

    const row = await getRunRow(runId);
    const reviewMinutes = REVIEW_PER_ITEM_TCD * 5;
    expect(row?.status).toBe("completed");
    expect(row?.review_minutes).toBe(reviewMinutes);
    expect(row?.generation_minutes).toBe(GENERATION_MINUTES);
    expect(row?.estimated_saved_minutes).toBe(MANUAL_TCD - reviewMinutes);
    expect(row?.cycle_saved_minutes).toBe(MANUAL_TCD - (GENERATION_MINUTES + reviewMinutes));
  });

  it("zeroes both savings when value is not realized", async () => {
    // Default resolution: nothing selected or published -> not realized.
    const unrealized = startWorkflowRun({ scope, workflowType: "test_case_design", userId });
    completeWorkflowRun({ scope, runId: unrealized, patch: { itemsGenerated: 3 } });

    // Explicit valueRealized: false wins even though items were selected.
    const overridden = startWorkflowRun({ scope, workflowType: "test_case_design", userId });
    completeWorkflowRun({
      scope,
      runId: overridden,
      valueRealized: false,
      patch: { itemsGenerated: 3, itemsSelected: 3 },
    });
    await flushBackgroundWrites();

    for (const runId of [unrealized, overridden]) {
      const row = await getRunRow(runId);
      // The effort breakdown is still recorded; only the savings are gated to zero.
      expect(row?.review_minutes).toBe(REVIEW_PER_ITEM_TCD * 3);
      expect(row?.estimated_saved_minutes).toBe(0);
      expect(row?.cycle_saved_minutes).toBe(0);
    }
  });

  it("resolves realization from the stored row when the completion patch omits item counts", async () => {
    const runId = startWorkflowRun({ scope, workflowType: "test_case_design", userId });
    updateWorkflowRun({ scope, runId, patch: { itemsGenerated: 4, itemsSelected: 2 } });
    // The patch omits itemsSelected/itemsGenerated: the stored 2 selected keeps the
    // run realized, and the stored 4 generated drives the per-item review estimate.
    completeWorkflowRun({ scope, runId, patch: { itemsPublished: 0 } });
    await flushBackgroundWrites();

    const row = await getRunRow(runId);
    const reviewMinutes = REVIEW_PER_ITEM_TCD * 4;
    expect(row?.estimated_saved_minutes).toBe(MANUAL_TCD - reviewMinutes);
    // No generation_completed_at -> unknown LLM time collapses cycle to the labor figure.
    expect(row?.cycle_saved_minutes).toBe(MANUAL_TCD - reviewMinutes);
  });

  it("lets an explicit patch value override the stored row for realization", async () => {
    const runId = startWorkflowRun({ scope, workflowType: "test_case_design", userId });
    updateWorkflowRun({ scope, runId, patch: { itemsGenerated: 4, itemsSelected: 2 } });
    // itemsSelected: 0 in the patch overrides the stored 2 -> not realized.
    completeWorkflowRun({ scope, runId, patch: { itemsSelected: 0, itemsPublished: 0 } });
    await flushBackgroundWrites();

    const row = await getRunRow(runId);
    expect(row?.estimated_saved_minutes).toBe(0);
    expect(row?.cycle_saved_minutes).toBe(0);
  });

  it("multiplies per-item review baselines by item count and keeps per-run baselines flat", async () => {
    // test_case_design reviews scale per generated item...
    const perItem = startWorkflowRun({ scope, workflowType: "test_case_design", userId });
    completeWorkflowRun({ scope, runId: perItem, valueRealized: true, patch: { itemsGenerated: 4 } });

    // ...business_owner_assistant is per-run: the same item count must not scale R.
    const perRun = startWorkflowRun({ scope, workflowType: "business_owner_assistant", userId });
    completeWorkflowRun({ scope, runId: perRun, valueRealized: true, patch: { itemsGenerated: 4 } });
    await flushBackgroundWrites();

    const perItemRow = await getRunRow(perItem);
    expect(perItemRow?.review_minutes).toBe(REVIEW_PER_ITEM_TCD * 4);
    expect(perItemRow?.estimated_saved_minutes).toBe(MANUAL_TCD - REVIEW_PER_ITEM_TCD * 4);

    const perRunRow = await getRunRow(perRun);
    expect(perRunRow?.review_minutes).toBe(REVIEW_PER_RUN_BOA);
    expect(perRunRow?.estimated_saved_minutes).toBe(MANUAL_BOA - REVIEW_PER_RUN_BOA);
  });

  it("records zero savings for failed runs", async () => {
    const runId = startWorkflowRun({ scope, workflowType: "test_case_design", userId });
    failWorkflowRun({ scope, runId, error: "boom" });
    await flushBackgroundWrites();

    const row = await getRunRow(runId);
    expect(row?.status).toBe("failed");
    expect(row?.estimated_saved_minutes).toBe(0);
    expect(row?.cycle_saved_minutes).toBe(0);
  });
});

async function getRunRow(runId: string) {
  return sqlGet<{
    status: string;
    estimated_saved_minutes: number;
    cycle_saved_minutes: number | null;
    review_minutes: number | null;
    generation_minutes: number | null;
  }>(
    `SELECT status, estimated_saved_minutes, cycle_saved_minutes, review_minutes, generation_minutes
     FROM analytics_workflow_runs
     WHERE id = @runId AND project_id = @projectId AND azure_project_id = @azureProjectId`,
    { runId, projectId: scope.projectId, azureProjectId: scope.azureProjectId },
  );
}
