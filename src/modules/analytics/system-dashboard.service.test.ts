import { beforeEach, describe, expect, it } from "vitest";

import { resetDatabaseForTests } from "@/modules/shared/infrastructure/database/db";
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

beforeEach(() => {
  // Each test runs against a fresh in-memory database (schema re-applied on init).
  process.env.ITESTFLOW_DB_PATH = ":memory:";
  resetDatabaseForTests();
});

describe("system dashboard analytics (DB-backed)", () => {
  it("does not count failed runs as estimated savings", () => {
    const run = startWorkflowRun({ scope, workflowType: "test_case_design" });
    failWorkflowRun({ scope, runId: run, error: "boom" });

    const analytics = getSystemDashboardAnalytics({ scope });
    expect(analytics.overview.estimatedHoursSaved.value).toBe(0);
  });
});
