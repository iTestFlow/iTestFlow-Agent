import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  resolveProjectScope: vi.fn(),
  getUserAzureAdapter: vi.fn(),
  executeSuiteMigration: vi.fn(),
  startWorkflowRun: vi.fn(() => "run-1"),
  completeWorkflowRun: vi.fn(),
  failWorkflowRun: vi.fn(),
  sanitizeAzureError: vi.fn((message: string) => `safe:${message}`),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return {
    ...actual,
    requireWorkflowContext: mocks.requireWorkflowContext,
    getUserAzureAdapter: mocks.getUserAzureAdapter,
  };
});
vi.mock("@/modules/projects/workspace-projects.service", () => ({
  resolveProjectScope: mocks.resolveProjectScope,
}));
vi.mock("@/modules/test-suite-migration/test-suite-migration.service", () => ({
  executeSuiteMigration: mocks.executeSuiteMigration,
}));
vi.mock("@/modules/analytics/workflow-analytics.service", () => ({
  startWorkflowRun: mocks.startWorkflowRun,
  completeWorkflowRun: mocks.completeWorkflowRun,
  failWorkflowRun: mocks.failWorkflowRun,
}));
vi.mock("@/shared/lib/sanitize-azure-error", () => ({
  sanitizeAzureError: mocks.sanitizeAzureError,
}));

import { SessionError } from "@/modules/auth/session.service";
import { fakeAzureAdapter, jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

const trustedScope = projectScope();

function body(overrides: Record<string, unknown> = {}) {
  return {
    scope: { ...trustedScope, workspaceId: "ws-1" },
    sourceProjectId: trustedScope.azureProjectId,
    sourceTestPlanId: "10",
    selectedSuiteIds: ["20"],
    targetProjectId: trustedScope.azureProjectId,
    targetTestPlanId: "30",
    targetParentSuiteId: "40",
    operationMode: "copy",
    outcomeMode: "latestOutcome",
    overwriteTargetOutcomes: false,
    conflictStrategy: "renameWithMigratedSuffix",
    ...overrides,
  };
}

function result(successfulActions = 1) {
  return {
    preview: { totalSuiteCount: 3, selectedRootSuiteCount: 1 },
    report: {
      actions: Array.from({ length: successfulActions }, () => ({ status: "success" })),
      summary: { suitesCreated: successfulActions },
    },
  };
}

describe("POST /api/test-suite-migration/execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startWorkflowRun.mockReturnValue("run-1");
    mocks.requireWorkflowContext.mockResolvedValue({
      userId: "user-1",
      workspace: { id: "ws-1" },
    });
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.getUserAzureAdapter.mockResolvedValue(fakeAzureAdapter());
    mocks.executeSuiteMigration.mockResolvedValue(result());
  });

  it("rejects malformed and schema-invalid input before authentication", async () => {
    const malformed = await POST(new Request("http://localhost/api/test-suite-migration/execute", {
      method: "POST",
      body: "{",
      headers: { "content-type": "application/json" },
    }));
    expect(malformed.status).toBe(400);

    const invalid = await POST(jsonRequest("/api/test-suite-migration/execute", body({
      selectedSuiteIds: [],
    })));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "Select at least one source suite." });
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("starts and completes analytics from the migration report", async () => {
    const response = await POST(jsonRequest("/api/test-suite-migration/execute", body()));

    expect(response.status).toBe(200);
    expect(mocks.executeSuiteMigration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: trustedScope, actor: "user-1" }),
    );
    expect(mocks.completeWorkflowRun).toHaveBeenCalledWith({
      scope: trustedScope,
      runId: "run-1",
      valueRealized: true,
      patch: {
        itemsGenerated: 3,
        itemsSelected: 1,
        itemsPublished: 1,
        manualActionsAvoided: 1,
        metadata: { migration: { suitesCreated: 1 } },
      },
    });
    expect(await response.json()).toMatchObject({ analyticsRunId: "run-1" });
  });

  it("fails analytics when migration returns no successful action", async () => {
    mocks.executeSuiteMigration.mockResolvedValue(result(0));
    const response = await POST(jsonRequest("/api/test-suite-migration/execute", body()));

    expect(response.status).toBe(200);
    expect(mocks.failWorkflowRun).toHaveBeenCalledWith({
      scope: trustedScope,
      runId: "run-1",
      error: "Suite migration completed without successful actions.",
    });
    expect(mocks.completeWorkflowRun).not.toHaveBeenCalled();
  });

  it("sanitizes downstream errors and fails the established run", async () => {
    mocks.executeSuiteMigration.mockRejectedValue(new Error("secret Azure failure"));
    const response = await POST(jsonRequest("/api/test-suite-migration/execute", body()));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "safe:secret Azure failure" });
    expect(mocks.failWorkflowRun).toHaveBeenCalledWith({
      scope: trustedScope,
      runId: "run-1",
      error: "secret Azure failure",
    });
  });

  it("maps authentication failure without starting analytics", async () => {
    mocks.requireWorkflowContext.mockRejectedValue(new SessionError());
    const response = await POST(jsonRequest("/api/test-suite-migration/execute", body()));

    expect(response.status).toBe(401);
    expect(mocks.startWorkflowRun).not.toHaveBeenCalled();
    expect(mocks.executeSuiteMigration).not.toHaveBeenCalled();
  });
});
