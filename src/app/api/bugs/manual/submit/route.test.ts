import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  resolveProjectScope: vi.fn(),
  completeManualBugReport: vi.fn(),
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
vi.mock("@/modules/bug-reporting/bug-reporting.service", () => ({
  completeManualBugReport: mocks.completeManualBugReport,
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
  return jsonRequest("/api/bugs/manual/submit", {
    scope: { ...trustedScope, workspaceId: "ws-1" },
    rawOutput: "external response",
    parentStoryId: "101",
    ...overrides,
  });
}

describe("POST /api/bugs/manual/submit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({
      userId: "user-1",
      workspace: { id: "ws-1" },
    });
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.startWorkflowRun.mockReturnValue("run-1");
    mocks.completeManualBugReport.mockReturnValue({
      provider: "external",
      model: "manual-external",
      rawOutput: "external response",
      validatedOutput: {
        title: "Checkout fails",
        severity: "2 - High",
        priority: 2,
        contextUsed: ["parent-story-101"],
      },
    });
  });

  it("returns the validated report and completes the analytics run", async () => {
    const response = await POST(submitRequest());

    expect(response.status).toBe(200);
    expect(mocks.completeManualBugReport).toHaveBeenCalledExactlyOnceWith({
      scope: trustedScope,
      actor: "user-1",
      rawOutput: "external response",
      parentStoryId: "101",
    });
    expect(mocks.updateWorkflowRun).toHaveBeenCalledExactlyOnceWith({
      scope: trustedScope,
      runId: "run-1",
      patch: expect.objectContaining({
        status: "generated",
        itemsGenerated: 1,
        usedKnowledgeContext: true,
        metadata: { contextUsed: ["parent-story-101"] },
      }),
    });
    expect(mocks.failWorkflowRun).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      analyticsRunId: "run-1",
      parentStoryId: "101",
      title: "Checkout fails",
    });
  });

  it("rejects malformed JSON before authenticating or starting analytics", async () => {
    const request = new Request("http://localhost/api/bugs/manual/submit", {
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

  it("preserves authorization failures without parsing the external response", async () => {
    mocks.requireWorkflowContext.mockRejectedValue(
      new WorkflowAuthError("Workspace access denied.", 403),
    );

    const response = await POST(submitRequest());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Workspace access denied." });
    expect(mocks.completeManualBugReport).not.toHaveBeenCalled();
    expect(mocks.startWorkflowRun).not.toHaveBeenCalled();
  });

  it("fails the started run and maps invalid pasted output to a 422", async () => {
    mocks.completeManualBugReport.mockImplementation(() => {
      throw new AppError({
        code: AppErrorCode.InvalidJson,
        message: "External output was not JSON.",
        userMessage: "The pasted response is not valid JSON.",
      });
    });

    const response = await POST(submitRequest());

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: "The pasted response is not valid JSON.",
      code: AppErrorCode.InvalidJson,
    });
    expect(mocks.failWorkflowRun).toHaveBeenCalledExactlyOnceWith({
      scope: trustedScope,
      runId: "run-1",
      error: "External output was not JSON.",
    });
    expect(mocks.updateWorkflowRun).not.toHaveBeenCalled();
  });
});
