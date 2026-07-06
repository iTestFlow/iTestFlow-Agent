import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  getUserAzureAdapter: vi.fn(),
  resolveProjectScope: vi.fn(),
  writeAuditLog: vi.fn(),
  createTestCase: vi.fn(),
  linkTestCaseToUserStory: vi.fn(),
  linkTestCaseToWorkItem: vi.fn(),
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

import { fakeAzureAdapter, jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

const trustedScope = projectScope();

function suggestedTestCase(overrides: Record<string, unknown> = {}) {
  return {
    localId: "repro-1",
    title: "Reproduce checkout crash",
    priority: "high",
    steps: [{ action: "Submit checkout", expectedResult: "A 500 error page is shown" }],
    ...overrides,
  };
}

function publishRequest(overrides: Record<string, unknown> = {}) {
  return jsonRequest("/api/bugs/reproduction-test-case/publish", {
    scope: { ...trustedScope, workspaceId: "ws-1" },
    parentStoryId: "42",
    bugId: "77",
    ...overrides,
  });
}

describe("POST /api/bugs/reproduction-test-case/publish", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "user-1", workspace: { id: "ws-1" } });
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.getUserAzureAdapter.mockResolvedValue(fakeAzureAdapter({
      createTestCase: mocks.createTestCase,
      linkTestCaseToUserStory: mocks.linkTestCaseToUserStory,
      linkTestCaseToWorkItem: mocks.linkTestCaseToWorkItem,
    }));
    mocks.createTestCase.mockResolvedValue({ success: true, azureTestCaseId: "900" });
    mocks.linkTestCaseToUserStory.mockResolvedValue({ success: true });
    mocks.linkTestCaseToWorkItem.mockResolvedValue({ success: true });
  });

  it("rejects a request naming both an existing and a suggested test case", async () => {
    const response = await POST(publishRequest({
      selectedTestCaseId: "500",
      suggestedTestCase: suggestedTestCase(),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Choose either an existing linked test case or one suggested reproduction test case.",
    });
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("rejects a request naming neither test case source", async () => {
    const response = await POST(publishRequest());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Choose either an existing linked test case or one suggested reproduction test case.",
    });
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("existing mode synthesizes create/storyLink successes and only links the bug", async () => {
    const response = await POST(publishRequest({ selectedTestCaseId: "500" }));

    expect(response.status).toBe(200);
    expect(mocks.createTestCase).not.toHaveBeenCalled();
    expect(mocks.linkTestCaseToUserStory).not.toHaveBeenCalled();
    expect(mocks.linkTestCaseToWorkItem).toHaveBeenCalledExactlyOnceWith({
      projectId: trustedScope.azureProjectId,
      workItemId: "77",
      azureTestCaseId: "500",
    });
    expect(await response.json()).toMatchObject({
      mode: "existing",
      azureTestCaseId: "500",
      success: true,
      create: { success: true, azureTestCaseId: "500" },
      storyLink: { success: true },
      bugLink: { success: true },
    });
    expect(mocks.writeAuditLog).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      entityId: "77",
      action: "bug_report.link_reproduction_test_case",
      status: "Success",
      message: "Linked test case 500 to Bug 77.",
    }));
  });

  it("suggested mode creates the case with the parent story and normalized priority, then links both work items", async () => {
    const response = await POST(publishRequest({ suggestedTestCase: suggestedTestCase() }));

    expect(response.status).toBe(200);
    expect(mocks.createTestCase).toHaveBeenCalledExactlyOnceWith({
      projectId: trustedScope.azureProjectId,
      testCase: expect.objectContaining({
        localId: "repro-1",
        targetUserStoryId: "42",
        priority: 2,
      }),
    });
    expect(mocks.linkTestCaseToUserStory).toHaveBeenCalledExactlyOnceWith({
      projectId: trustedScope.azureProjectId,
      userStoryId: "42",
      azureTestCaseId: "900",
    });
    expect(mocks.linkTestCaseToWorkItem).toHaveBeenCalledExactlyOnceWith({
      projectId: trustedScope.azureProjectId,
      workItemId: "77",
      azureTestCaseId: "900",
    });
    expect(await response.json()).toMatchObject({ mode: "suggested", azureTestCaseId: "900", success: true });
  });

  it("skips the bug link when creation fails and reports the create error first", async () => {
    mocks.createTestCase.mockResolvedValue({ success: false, error: "create failed" });

    const response = await POST(publishRequest({ suggestedTestCase: suggestedTestCase() }));

    expect(response.status).toBe(200);
    expect(mocks.linkTestCaseToUserStory).not.toHaveBeenCalled();
    expect(mocks.linkTestCaseToWorkItem).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      success: false,
      error: "create failed",
      bugLink: {
        success: false,
        error: "Skipped because test case creation or user story linking failed.",
      },
    });
    expect(mocks.writeAuditLog).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      status: "Partial failure",
      message: "Could not fully link the reproduction test case to Bug 77.",
    }));
  });

  it("reports the story-link error when creation succeeded but the story link failed", async () => {
    mocks.linkTestCaseToUserStory.mockResolvedValue({ success: false, error: "story link failed" });

    const response = await POST(publishRequest({ suggestedTestCase: suggestedTestCase() }));

    expect(response.status).toBe(200);
    expect(mocks.linkTestCaseToWorkItem).not.toHaveBeenCalled();
    // error picks the first failing step: create.error ?? storyLink.error ?? bugLink.error.
    expect(await response.json()).toMatchObject({
      success: false,
      error: "story link failed",
      create: { success: true },
      storyLink: { success: false },
      bugLink: { success: false, error: "Skipped because test case creation or user story linking failed." },
    });
    expect(mocks.writeAuditLog).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: "Partial failure" }),
    );
  });

  it("reports the bug-link error when only the final link failed", async () => {
    mocks.linkTestCaseToWorkItem.mockResolvedValue({ success: false, error: "bug link failed" });

    const response = await POST(publishRequest({ selectedTestCaseId: "500" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: false, error: "bug link failed" });
    expect(mocks.writeAuditLog).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: "Partial failure" }),
    );
  });

  it("maps an adapter failure to a sanitized 503 without writing an audit entry", async () => {
    mocks.createTestCase.mockRejectedValue(new Error("Azure unavailable"));

    const response = await POST(publishRequest({ suggestedTestCase: suggestedTestCase() }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Azure unavailable" });
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });
});
