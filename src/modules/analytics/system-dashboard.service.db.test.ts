import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  flushBackgroundWrites,
  resetDatabaseForTests,
  sqlRun,
} from "@/modules/shared/infrastructure/database/db";
import {
  failWorkflowRun,
  startWorkflowRun,
} from "@/modules/analytics/workflow-analytics.service";
import {
  getSystemDashboardAnalytics,
} from "@/modules/analytics/system-dashboard.service";

const scope = {
  projectId: "project-1",
  azureProjectId: "azure-project-1",
  azureProjectName: "Demo Project",
  azureOrganizationUrl: "https://dev.azure.com/demo",
};
const dropdownUserA = "user_system_dashboard_dropdown_a";
const dropdownUserB = "user_system_dashboard_dropdown_b";

// A second, distinct project scope used to prove cross-project isolation: rows
// inserted here must never leak into reads scoped to `scope` above.
// analytics_workflow_runs has no FK to projects, so no workspace/project seeding
// is required to insert rows under this scope.
const otherScope = {
  projectId: "project-2",
  azureProjectId: "azure-project-2",
  azureProjectName: "Other Project",
  azureOrganizationUrl: "https://dev.azure.com/other",
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

  afterEach(async () => {
    await sqlRun(
      `DELETE FROM analytics_workflow_runs
       WHERE project_id = @projectId AND azure_project_id = @azureProjectId`,
      { projectId: scope.projectId, azureProjectId: scope.azureProjectId },
    );
  });

  afterAll(async () => {
    await sqlRun(
      `DELETE FROM users WHERE id IN (@userA, @userB)`,
      { userA: dropdownUserA, userB: dropdownUserB },
    );
    await resetDatabaseForTests();
  });

  it("does not count failed runs as estimated savings", async () => {
    const run = startWorkflowRun({ scope, workflowType: "test_case_design", userId: "user_test" });
    failWorkflowRun({ scope, runId: run, error: "boom" });
    // Analytics writes are enqueued on a serialized background queue; flush before reading.
    await flushBackgroundWrites();

    const analytics = await getSystemDashboardAnalytics({ scope });
    expect(analytics.overview.laborHoursSaved.value).toBe(0);
    expect(analytics.overview.cycleHoursSaved.value).toBe(0);
  });

  it("keeps all visible user options when analytics are filtered to one user", async () => {
    await seedAnalyticsUser({
      id: dropdownUserA,
      displayName: "Abdelrahman Ellithy",
      email: "abdelrahman.system-dashboard@example.test",
    });
    await seedAnalyticsUser({
      id: dropdownUserB,
      displayName: "Mahmoud ElSharkawy",
      email: "mahmoud.system-dashboard@example.test",
    });

    startWorkflowRun({ scope, workflowType: "requirements_analysis", userId: dropdownUserA });
    startWorkflowRun({ scope, workflowType: "test_case_design", userId: dropdownUserB });
    await flushBackgroundWrites();

    const analytics = await getSystemDashboardAnalytics({
      scope,
      filters: { userId: dropdownUserA },
      userOptionsUserId: null,
    });

    expect(analytics.filters.userId).toBe(dropdownUserA);
    expect(analytics.adoption.activeUsers).toBe(1);
    expect(analytics.adoption.workflowRuns).toBe(1);
    expect(analytics.filterMetadata.users).toEqual([
      { value: dropdownUserA, label: "Abdelrahman Ellithy" },
      { value: dropdownUserB, label: "Mahmoud ElSharkawy" },
    ]);
  });

  it("excludes analytics runs from other projects", async () => {
    // Seed one run under the default scope and one under a DISTINCT project scope.
    // The read below is scoped to `scope`, so the other project's row must be
    // excluded by the project_id/azure_project_id WHERE clause.
    startWorkflowRun({ scope, workflowType: "test_case_design", userId: "user_default_scope" });
    startWorkflowRun({ scope: otherScope, workflowType: "requirements_analysis", userId: "user_other_scope" });
    // Analytics writes are enqueued on a serialized background queue; flush before reading.
    await flushBackgroundWrites();

    try {
      const analytics = await getSystemDashboardAnalytics({ scope, userOptionsUserId: null });

      // Only the default-scope run is visible; the project-2 run is filtered out.
      expect(analytics.adoption.workflowRuns).toBe(1);
      expect(analytics.adoption.activeUsers).toBe(1);
      expect(analytics.filterMetadata.users).toEqual([
        { value: "user_default_scope", label: "user_default_scope" },
      ]);
    } finally {
      // The shared beforeEach/afterEach only clean the default scope, so remove
      // this test's second-project rows explicitly to avoid leaking across tests.
      await sqlRun(
        `DELETE FROM analytics_workflow_runs
         WHERE project_id = @projectId AND azure_project_id = @azureProjectId`,
        { projectId: otherScope.projectId, azureProjectId: otherScope.azureProjectId },
      );
    }
  });
});

async function seedAnalyticsUser(input: { id: string; displayName: string; email: string }) {
  await sqlRun(
    `INSERT INTO users (id, display_name, email_or_unique_name, status, created_at)
     VALUES (@id, @displayName, @email, 'active', @now)
     ON CONFLICT (id)
     DO UPDATE SET display_name = EXCLUDED.display_name,
                   email_or_unique_name = EXCLUDED.email_or_unique_name,
                   status = 'active'`,
    {
      id: input.id,
      displayName: input.displayName,
      email: input.email,
      now: new Date().toISOString(),
    },
  );
}
