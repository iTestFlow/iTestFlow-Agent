import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  getUserAzureAdapter: vi.fn(),
  resolveProjectScope: vi.fn(),
  writeAuditLog: vi.fn(),
  completeWorkflowRun: vi.fn(),
  failWorkflowRun: vi.fn(),
  createTestCase: vi.fn(),
  linkTestCaseToUserStory: vi.fn(),
}));

// Keep the real authErrorResponse so auth failures raised by the mocked
// context/adapter resolvers still exercise the route's 401/403 mapping.
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
vi.mock("@/modules/audit/audit.service", () => ({
  writeAuditLog: mocks.writeAuditLog,
}));
vi.mock("@/modules/analytics/workflow-analytics.service", () => ({
  completeWorkflowRun: mocks.completeWorkflowRun,
  failWorkflowRun: mocks.failWorkflowRun,
}));

import { fakeAzureAdapter, jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

const trustedScope = projectScope();

function testCaseInput(overrides: Record<string, unknown> = {}) {
  return {
    localId: "tc-1",
    targetUserStoryId: "42",
    title: "Covers the missing edge case",
    steps: [{ action: "Submit an empty cart", expectedResult: "A validation error is shown" }],
    priority: "medium",
    ...overrides,
  };
}

function publishRequest(overrides: Record<string, unknown> = {}) {
  return jsonRequest("/api/test-coverage-matrix/suggested-additions/publish", {
    scope: { ...trustedScope, workspaceId: "ws-1" },
    targetWorkItemId: "42",
    testCases: [testCaseInput()],
    ...overrides,
  });
}

describe("POST /api/test-coverage-matrix/suggested-additions/publish", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "user-1", workspace: { id: "ws-1" } });
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.getUserAzureAdapter.mockResolvedValue(fakeAzureAdapter({
      createTestCase: mocks.createTestCase,
      linkTestCaseToUserStory: mocks.linkTestCaseToUserStory,
    }));
    mocks.createTestCase.mockResolvedValue({ success: true, azureTestCaseId: "900" });
    mocks.linkTestCaseToUserStory.mockResolvedValue({ success: true });
  });

  it("creates and links each suggested case and audits a full Success", async () => {
    const response = await POST(publishRequest());

    expect(response.status).toBe(200);
    expect(mocks.createTestCase).toHaveBeenCalledExactlyOnceWith({
      projectId: trustedScope.azureProjectId,
      testCase: expect.objectContaining({ localId: "tc-1", priority: 3 }),
    });
    expect(mocks.linkTestCaseToUserStory).toHaveBeenCalledExactlyOnceWith({
      projectId: trustedScope.azureProjectId,
      userStoryId: "42",
      azureTestCaseId: "900",
    });
    expect(await response.json()).toEqual({
      targetWorkItemId: "42",
      results: [expect.objectContaining({ localId: "tc-1", azureTestCaseId: "900", success: true })],
    });
    expect(mocks.writeAuditLog).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      entityId: "42",
      action: "test_coverage_matrix.publish_suggested_additions",
      status: "Success",
      message: "Created and linked 1 of 1 suggested test cases.",
    }));
  });

  it("skips the story link when creation fails and records the skip on the result", async () => {
    mocks.createTestCase.mockResolvedValue({ success: false, error: "create failed" });

    const response = await POST(publishRequest());

    expect(response.status).toBe(200);
    expect(mocks.linkTestCaseToUserStory).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      results: [{
        localId: "tc-1",
        success: false,
        error: "create failed",
        link: { success: false, error: "Skipped because test case creation failed." },
      }],
    });
  });

  it("treats a create success without an Azure ID as failed and skips the link", async () => {
    mocks.createTestCase.mockResolvedValue({ success: true });

    const response = await POST(publishRequest());

    expect(response.status).toBe(200);
    expect(mocks.linkTestCaseToUserStory).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      results: [{
        success: false,
        link: { success: false, error: "Skipped because test case creation failed." },
      }],
    });
  });

  it("audits Partial failure when only some cases publish, continuing past failures", async () => {
    mocks.createTestCase
      .mockResolvedValueOnce({ success: false, error: "create failed" })
      .mockResolvedValueOnce({ success: true, azureTestCaseId: "901" });

    const response = await POST(publishRequest({
      testCases: [testCaseInput(), testCaseInput({ localId: "tc-2" })],
    }));

    expect(response.status).toBe(200);
    expect(mocks.createTestCase).toHaveBeenCalledTimes(2);
    expect(mocks.linkTestCaseToUserStory).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ azureTestCaseId: "901" }),
    );
    expect(mocks.writeAuditLog).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      status: "Partial failure",
      message: "Created and linked 1 of 2 suggested test cases.",
    }));
  });

  it("audits Failed when nothing publishes and fails the analytics run", async () => {
    mocks.createTestCase.mockResolvedValue({ success: false, error: "create failed" });

    const response = await POST(publishRequest({ analyticsRunId: "run-1" }));

    expect(response.status).toBe(200);
    expect(mocks.writeAuditLog).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: "Failed" }),
    );
    expect(mocks.failWorkflowRun).toHaveBeenCalledExactlyOnceWith({
      scope: trustedScope,
      runId: "run-1",
      error: "No suggested test cases were published successfully.",
    });
    expect(mocks.completeWorkflowRun).not.toHaveBeenCalled();
  });

  it("counts create and link successes independently in manualActionsAvoided", async () => {
    // tc-1: created but link failed (1 action); tc-2: created and linked (2 actions).
    mocks.linkTestCaseToUserStory
      .mockResolvedValueOnce({ success: false, error: "link failed" })
      .mockResolvedValueOnce({ success: true });

    const response = await POST(publishRequest({
      testCases: [testCaseInput(), testCaseInput({ localId: "tc-2" })],
      analyticsRunId: "run-1",
      itemsGenerated: 5,
      itemsEdited: 1,
    }));

    expect(response.status).toBe(200);
    expect(mocks.completeWorkflowRun).toHaveBeenCalledExactlyOnceWith({
      scope: trustedScope,
      runId: "run-1",
      status: "published",
      valueRealized: true,
      patch: {
        itemsSelected: 2,
        itemsEdited: 1,
        itemsPublished: 1,
        itemsRejected: 3,
        manualActionsAvoided: 3,
      },
    });
    expect(mocks.failWorkflowRun).not.toHaveBeenCalled();
  });

  it("clamps itemsRejected at zero when itemsGenerated is absent or below the selection", async () => {
    const absent = await POST(publishRequest({ analyticsRunId: "run-1" }));
    expect(absent.status).toBe(200);
    expect(mocks.completeWorkflowRun).toHaveBeenLastCalledWith(
      expect.objectContaining({ patch: expect.objectContaining({ itemsRejected: 0 }) }),
    );

    const below = await POST(publishRequest({ analyticsRunId: "run-1", itemsGenerated: 0 }));
    expect(below.status).toBe(200);
    expect(mocks.completeWorkflowRun).toHaveBeenLastCalledWith(
      expect.objectContaining({ patch: expect.objectContaining({ itemsRejected: 0 }) }),
    );
  });

  it("fails the analytics run and returns 503 when the adapter throws after scope resolution", async () => {
    mocks.createTestCase.mockRejectedValue(new Error("Azure unavailable"));

    const response = await POST(publishRequest({ analyticsRunId: "run-1" }));

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toBe("The service is temporarily unavailable. Try again in a moment.");
    expect(body.technicalDetails).toContain("Azure unavailable");
    expect(mocks.failWorkflowRun).toHaveBeenCalledExactlyOnceWith({
      scope: trustedScope,
      runId: "run-1",
      error: "Azure unavailable",
    });
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });
});
