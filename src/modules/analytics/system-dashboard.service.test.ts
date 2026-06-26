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
import { formatSystemDashboardUserLabel, getSystemDashboardAnalytics } from "@/modules/analytics/system-dashboard.service";

const scope = {
  projectId: "project-1",
  azureProjectId: "azure-project-1",
  azureProjectName: "Demo Project",
  azureOrganizationUrl: "https://dev.azure.com/demo",
};
const dropdownUserA = "user_system_dashboard_dropdown_a";
const dropdownUserB = "user_system_dashboard_dropdown_b";

// DB-backed integration test. Requires a migrated PostgreSQL reachable via DATABASE_URL
// (e.g. `docker compose --profile test up -d postgres-test`, point DATABASE_URL at it,
// then `npm run db:migrate`). Skipped when DATABASE_URL is unset so the default unit
// test run requires no database (ADR-9).
const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describe("system dashboard user labels", () => {
  it("prefers display name over email and raw user id", () => {
    expect(formatSystemDashboardUserLabel({
      id: "user_41184895-b2d7-484b-8334-414cb2d8d5d3",
      displayName: "Mahmoud ElSharkawy",
      emailOrUniqueName: "mahmoud@example.com",
    })).toBe("Mahmoud ElSharkawy");
  });

  it("falls back to email before raw user id", () => {
    expect(formatSystemDashboardUserLabel({
      id: "user_3acaac35-43b1-4e03-b051-a7cd33bf6ea1",
      displayName: " ",
      emailOrUniqueName: "abdelrahman@example.com",
    })).toBe("abdelrahman@example.com");
  });
});

describeDb("system dashboard analytics (DB-backed)", () => {
  beforeEach(async () => {
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
    expect(analytics.overview.estimatedHoursSaved.value).toBe(0);
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
