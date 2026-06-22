import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  flushBackgroundWrites,
  resetDatabaseForTests,
  sqlRun,
} from "@/modules/shared/infrastructure/database/db";
import {
  failWorkflowRun,
  startWorkflowRun,
} from "@/modules/analytics/workflow-analytics.service";
import { getSystemDashboardAnalytics } from "@/modules/analytics/system-dashboard.service";

const scope = {
  projectId: "project-1",
  azureProjectId: "azure-project-1",
  azureProjectName: "Demo Project",
  azureOrganizationUrl: "https://dev.azure.com/demo",
};

// DB-backed integration test. Requires a migrated PostgreSQL reachable via DATABASE_URL
// (e.g. `docker compose --profile test up -d postgres-test`, point DATABASE_URL at it,
// then `npm run db:migrate`). Skipped when DATABASE_URL is unset so the default unit
// test run requires no database (ADR-9).
const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb("system dashboard analytics (DB-backed)", () => {
  beforeEach(async () => {
    await sqlRun(
      `DELETE FROM analytics_workflow_runs
       WHERE project_id = @projectId AND azure_project_id = @azureProjectId`,
      { projectId: scope.projectId, azureProjectId: scope.azureProjectId },
    );
  });

  afterAll(async () => {
    await resetDatabaseForTests();
  });

  it("does not count failed runs as estimated savings", async () => {
    const run = startWorkflowRun({ scope, workflowType: "test_case_design", userId: "user_test" });
    failWorkflowRun({ scope, runId: run, error: "boom" });
    // Analytics writes are enqueued on a serialized background queue; flush before reading.
    await flushBackgroundWrites();

    const analytics = await getSystemDashboardAnalytics({ scope });
    expect(analytics.overview.estimatedHoursSaved.value).toBe(0);
  });
});
