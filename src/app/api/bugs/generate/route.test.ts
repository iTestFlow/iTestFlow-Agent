import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  getUserAzureAdapter: vi.fn(),
  getUserLLMProvider: vi.fn(),
  resolveProjectScope: vi.fn(),
  fetchWorkItemById: vi.fn(),
  generateBugReport: vi.fn(),
  loadProjectKnowledgeContext: vi.fn(),
  writeGenerationFailureAudit: vi.fn(),
  startWorkflowRun: vi.fn(),
  updateWorkflowRun: vi.fn(),
  failWorkflowRun: vi.fn(),
}));

// Keep the real authErrorResponse so the route's auth-error short-circuit in the
// catch block is exercised against real error classes (it must return null for
// generation failures, letting them reach the audit + failWorkflowRun path).
vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return {
    ...actual,
    requireWorkflowContext: mocks.requireWorkflowContext,
    getUserAzureAdapter: mocks.getUserAzureAdapter,
    getUserLLMProvider: mocks.getUserLLMProvider,
  };
});
// generateBugReport's prompt/audit behavior is covered by bug-reporting.test.ts;
// here it is a boundary the route orchestrates around.
vi.mock("@/modules/bug-reporting/bug-reporting.service", () => ({
  generateBugReport: mocks.generateBugReport,
}));
vi.mock("@/modules/projects/workspace-projects.service", () => ({
  resolveProjectScope: mocks.resolveProjectScope,
}));
vi.mock("@/modules/rag/project-knowledge.service", () => ({
  loadProjectKnowledgeContext: mocks.loadProjectKnowledgeContext,
}));
vi.mock("@/modules/audit/generation-failure-audit", () => ({
  writeGenerationFailureAudit: mocks.writeGenerationFailureAudit,
}));
vi.mock("@/modules/analytics/workflow-analytics.service", () => ({
  startWorkflowRun: mocks.startWorkflowRun,
  updateWorkflowRun: mocks.updateWorkflowRun,
  failWorkflowRun: mocks.failWorkflowRun,
}));

import { WorkflowAuthError } from "@/modules/credentials/scoped-resolution.service";
import { AppError, AppErrorCode } from "@/modules/shared/errors/app-error";
import { fakeAzureAdapter, fakeLlmProvider, jsonRequest, projectScope, requirement } from "@/test/factories";
import { POST } from "./route";

const trustedScope = projectScope();

function generatedReport(contextUsed: string[] = []) {
  return {
    title: "Checkout fails on submit",
    precondition: "A cart with one item",
    stepsToReproduce: "1. Open checkout\n2. Submit",
    expectedResult: "Order confirmation is shown",
    actualResult: "A 500 error page is shown",
    systemInfo: "Not specified",
    severity: "2 - High",
    priority: 2,
    contextUsed,
  };
}

function generateRequest(overrides: Record<string, unknown> = {}) {
  return jsonRequest("/api/bugs/generate", {
    scope: { ...trustedScope, workspaceId: "ws-1" },
    bugDescription: "Checkout returns a 500 on submit.",
    ...overrides,
  });
}

describe("POST /api/bugs/generate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "user-1", workspace: { id: "ws-1" } });
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.getUserLLMProvider.mockResolvedValue(fakeLlmProvider());
    mocks.getUserAzureAdapter.mockResolvedValue(
      fakeAzureAdapter({ fetchWorkItemById: mocks.fetchWorkItemById }),
    );
    mocks.startWorkflowRun.mockReturnValue("run-1");
    mocks.loadProjectKnowledgeContext.mockResolvedValue({ knowledgeBase: null, health: null, usage: "raw_only", promptNotice: null });
    mocks.generateBugReport.mockResolvedValue({
      provider: "openai",
      model: "test-model",
      rawOutput: "{}",
      validatedOutput: generatedReport(),
    });
  });

  it("rejects a non-User-Story parent with a 400 naming the actual type and finalizes the analytics run", async () => {
    mocks.fetchWorkItemById.mockResolvedValue(requirement({ id: "42", workItemType: "Task" }));

    const response = await POST(generateRequest({ parentStoryId: "42" }));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("42");
    expect(body.error).toContain("Task");
    // Regression: the run started before the parent-type check must be failed,
    // not leaked in "started", when the route returns early.
    expect(mocks.failWorkflowRun).toHaveBeenCalledExactlyOnceWith({
      scope: trustedScope,
      runId: "run-1",
      error: expect.stringContaining("Task"),
    });
    expect(mocks.generateBugReport).not.toHaveBeenCalled();
    expect(mocks.updateWorkflowRun).not.toHaveBeenCalled();
  });

  it("skips the work-item lookup entirely when parentStoryId is omitted", async () => {
    const response = await POST(generateRequest());

    expect(response.status).toBe(200);
    expect(mocks.fetchWorkItemById).not.toHaveBeenCalled();
    expect(mocks.generateBugReport).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ scope: trustedScope, actor: "user-1", parentStory: null }),
    );
    expect(await response.json()).toMatchObject({ analyticsRunId: "run-1", parentStoryId: null });
  });

  it("rejects malformed JSON with the 400 validation response before authenticating or starting analytics", async () => {
    const request = new Request("http://localhost/api/bugs/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    const response = await POST(request);

    // Regression: the body parse happens outside the try block, so without the
    // .catch(() => ({})) guard the rejection would escape POST as an unhandled 500.
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
    expect(mocks.startWorkflowRun).not.toHaveBeenCalled();
  });

  it("maps an auth rejection through the real authErrorResponse without starting analytics", async () => {
    mocks.requireWorkflowContext.mockRejectedValue(
      new WorkflowAuthError("Workspace access denied.", 403),
    );

    const response = await POST(generateRequest());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Workspace access denied." });
    expect(mocks.generateBugReport).not.toHaveBeenCalled();
    expect(mocks.startWorkflowRun).not.toHaveBeenCalled();
    // The auth short-circuit returns before the audit + failWorkflowRun fallback.
    expect(mocks.writeGenerationFailureAudit).not.toHaveBeenCalled();
    expect(mocks.failWorkflowRun).not.toHaveBeenCalled();
  });

  it("maps a generation failure to its audit entry, a failed run, and the statusForServerError status", async () => {
    mocks.generateBugReport.mockRejectedValue(new AppError({
      code: AppErrorCode.ProviderUnavailable,
      message: "OpenAI returned 503.",
      userMessage: "The LLM provider is currently unavailable.",
    }));

    const response = await POST(generateRequest());

    // ProviderUnavailable -> 503 via statusForServerError, sanitized via toErrorResponse.
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "The LLM provider is currently unavailable.",
      code: AppErrorCode.ProviderUnavailable,
    });
    expect(mocks.writeGenerationFailureAudit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ scope: trustedScope, actor: "user-1", action: "bug_report.generate" }),
    );
    expect(mocks.failWorkflowRun).toHaveBeenCalledExactlyOnceWith({
      scope: trustedScope,
      runId: "run-1",
      error: "OpenAI returned 503.",
    });
    expect(mocks.updateWorkflowRun).not.toHaveBeenCalled();
  });

  it("completes the run on success with usedKnowledgeContext derived from context citations", async () => {
    mocks.fetchWorkItemById.mockResolvedValue(requirement({ id: "42", workItemType: "User Story" }));
    mocks.generateBugReport.mockResolvedValue({
      provider: "openai",
      model: "test-model",
      rawOutput: "{}",
      validatedOutput: generatedReport(["parent-story-42"]),
    });

    const response = await POST(generateRequest({ parentStoryId: "42" }));

    expect(response.status).toBe(200);
    expect(mocks.updateWorkflowRun).toHaveBeenCalledExactlyOnceWith({
      scope: trustedScope,
      runId: "run-1",
      patch: expect.objectContaining({
        status: "generated",
        itemsGenerated: 1,
        usedKnowledgeContext: true,
        metadata: { contextUsed: ["parent-story-42"] },
      }),
    });
    expect(mocks.failWorkflowRun).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      analyticsRunId: "run-1",
      parentStoryId: "42",
      contextUsed: ["parent-story-42"],
    });
  });

  it("records usedKnowledgeContext=false when the report cites no context", async () => {
    const response = await POST(generateRequest());

    expect(response.status).toBe(200);
    expect(mocks.updateWorkflowRun).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ patch: expect.objectContaining({ usedKnowledgeContext: false }) }),
    );
  });
});
