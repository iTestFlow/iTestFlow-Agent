import { beforeEach, describe, expect, it } from "vitest";

import { writeAuditLog } from "@/modules/audit/audit.service";
import { resetDatabaseForTests } from "@/modules/shared/infrastructure/database/db";
import {
  completeWorkflowRun,
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

function publishAudit(status: "Success" | "Partial failure" | "Failed") {
  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    entityType: "work_item",
    entityId: "123",
    action: "azure_devops.publish_test_cases",
    status,
    message: status,
  });
}

describe("system dashboard analytics (DB-backed)", () => {
  it("scopes acceptance rate to publish-oriented workflows (excludes conversational runs)", () => {
    const designRun = startWorkflowRun({ scope, workflowType: "test_case_design" });
    completeWorkflowRun({
      scope,
      runId: designRun,
      status: "published",
      patch: { itemsGenerated: 5, itemsSelected: 5, itemsPublished: 5 },
    });
    // A chatbot run generates 1 item but has no select/publish step — must NOT drag the rate.
    const chatRun = startWorkflowRun({ scope, workflowType: "business_owner_assistant" });
    completeWorkflowRun({ scope, runId: chatRun, patch: { itemsGenerated: 1 } });

    const analytics = getSystemDashboardAnalytics({ scope });
    // 5 accepted / 5 generated among publish workflows = 100% (would be 83.3% if the
    // chatbot's generated-but-unaccepted item were counted).
    expect(analytics.overview.acceptanceRate.value).toBe(100);
    expect(
      analytics.workflowSavings.rows.find(
        (row) => row.workflowType === "business_owner_assistant",
      )?.acceptanceRate,
    ).toBeNull();
  });

  it("computes rejection rate from item counts and keeps it <= 100%", () => {
    const run = startWorkflowRun({ scope, workflowType: "test_case_design" });
    completeWorkflowRun({
      scope,
      runId: run,
      status: "published",
      patch: { itemsGenerated: 1, itemsPublished: 1, itemsRejected: 1 },
    });
    const analytics = getSystemDashboardAnalytics({ scope });
    // 1 rejected item / 1 generated item = 100% (the old mixed-unit formula gave 200%).
    expect(analytics.adoption.rejectionRate).toBe(100);
  });

  it("counts only full successes toward publish success rate; partial failures are neutral", () => {
    publishAudit("Success");
    publishAudit("Partial failure");
    publishAudit("Failed");

    const analytics = getSystemDashboardAnalytics({ scope });
    // 1 full Success / 3 audits = 33.3% (the old formula counted the partial as success -> 66.7%).
    expect(analytics.adoAutomation.publishSuccessRate).toBe(33.3);
    // Only the true "Failed" audit is a failed operation; the partial is neither.
    expect(analytics.adoAutomation.failedOperations).toBe(1);
  });

  it("does not count failed runs as estimated savings", () => {
    const run = startWorkflowRun({ scope, workflowType: "test_case_design" });
    failWorkflowRun({ scope, runId: run, error: "boom" });

    const analytics = getSystemDashboardAnalytics({ scope });
    expect(analytics.overview.estimatedHoursSaved.value).toBe(0);
  });
});
