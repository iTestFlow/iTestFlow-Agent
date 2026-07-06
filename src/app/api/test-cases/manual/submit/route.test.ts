import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  resolveProjectScope: vi.fn(),
  completeManualTestCaseGeneration: vi.fn(),
  startWorkflowRun: vi.fn(),
  updateWorkflowRun: vi.fn(),
  failWorkflowRun: vi.fn(),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return { ...actual, requireWorkflowContext: mocks.requireWorkflowContext };
});
vi.mock("@/modules/projects/workspace-projects.service", () => ({
  resolveProjectScope: mocks.resolveProjectScope,
}));
vi.mock("@/modules/test-case-design/application/test-case-generation.service", () => ({
  completeManualTestCaseGeneration: mocks.completeManualTestCaseGeneration,
}));
vi.mock("@/modules/analytics/workflow-analytics.service", () => ({
  startWorkflowRun: mocks.startWorkflowRun,
  updateWorkflowRun: mocks.updateWorkflowRun,
  failWorkflowRun: mocks.failWorkflowRun,
}));

import { WorkflowAuthError } from "@/modules/credentials/scoped-resolution.service";
import { AppError, AppErrorCode } from "@/modules/shared/errors/app-error";
import { jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

const trustedScope = projectScope();

function submitRequest(overrides: Record<string, unknown> = {}) {
  return jsonRequest("/api/test-cases/manual/submit", {
    scope: { ...trustedScope, workspaceId: "ws-1" },
    targetWorkItemId: "101",
    rawOutput: "external response",
    contextCitations: [],
    ...overrides,
  });
}

describe("POST /api/test-cases/manual/submit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({
      userId: "user-1",
      workspace: { id: "ws-1" },
    });
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.startWorkflowRun.mockReturnValue("run-1");
    mocks.completeManualTestCaseGeneration.mockReturnValue({
      provider: "external",
      model: "manual-external",
      rawOutput: "external response",
      validatedOutput: {
        testCases: [{ id: "TC-1", type: "functional", category: "negative" }],
        summary: { totalCases: 1, coverageEstimate: 82 },
        contextUsed: ["requirement-101"],
      },
    });
  });

  it("returns generated cases and completes analytics with observable coverage metadata", async () => {
    const response = await POST(submitRequest({
      selectedContextIds: ["202"],
      contextCitations: [{
        sourceType: "project_context",
        sourceId: "WI:202",
        title: "Payment API",
        workItemId: "202",
        workItemType: "User Story",
      }],
      retrievalTopK: 5,
    }));

    expect(response.status).toBe(200);
    expect(mocks.completeManualTestCaseGeneration).toHaveBeenCalledExactlyOnceWith({
      scope: trustedScope,
      actor: "user-1",
      rawOutput: "external response",
      targetWorkItemId: "101",
    });
    expect(mocks.updateWorkflowRun).toHaveBeenCalledExactlyOnceWith({
      scope: trustedScope,
      runId: "run-1",
      patch: expect.objectContaining({
        status: "generated",
        itemsGenerated: 1,
        usedKnowledgeContext: true,
        metadata: {
          testDesign: { categories: { Negative: 1 } },
          coverage: { score: 82 },
          contextUsed: ["requirement-101"],
        },
      }),
    });
    expect(mocks.failWorkflowRun).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      analyticsRunId: "run-1",
      targetWorkItemId: "101",
      retrievalTopK: 5,
      testCases: [{ id: "TC-1" }],
    });
  });

  it("rejects malformed JSON before authenticating or starting analytics", async () => {
    const request = new Request("http://localhost/api/test-cases/manual/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
    expect(mocks.startWorkflowRun).not.toHaveBeenCalled();
  });

  it("rejects an empty external response with the stable paste-response message", async () => {
    const response = await POST(submitRequest({ rawOutput: "" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Paste the external LLM response before continuing.",
    });
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
    expect(mocks.startWorkflowRun).not.toHaveBeenCalled();
  });

  it("preserves authorization failures without starting a workflow run", async () => {
    mocks.requireWorkflowContext.mockRejectedValue(
      new WorkflowAuthError("Project access denied.", 403),
    );

    const response = await POST(submitRequest());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Project access denied." });
    expect(mocks.startWorkflowRun).not.toHaveBeenCalled();
  });

  it("fails the started run and maps invalid pasted output to a 422", async () => {
    mocks.completeManualTestCaseGeneration.mockImplementation(() => {
      throw new AppError({
        code: AppErrorCode.SchemaValidation,
        message: "testCases is required.",
        userMessage: "The pasted output does not match the expected format.",
      });
    });

    const response = await POST(submitRequest());

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: "The pasted output does not match the expected format.",
      code: AppErrorCode.SchemaValidation,
    });
    expect(mocks.failWorkflowRun).toHaveBeenCalledExactlyOnceWith({
      scope: trustedScope,
      runId: "run-1",
      error: "testCases is required.",
    });
    expect(mocks.updateWorkflowRun).not.toHaveBeenCalled();
  });
});
